#!/usr/bin/env node
/**
 * Make a host the ACTIVE one: it gets the public traffic (Cloudflare tunnel), the crons, and the production CI
 * jobs (the `glados` runner label). Everything else keeps running on the old host as a standby.
 *
 *   node ci/scripts/host/promote.mjs bouldergeist            # shows the plan, changes nothing
 *   node ci/scripts/host/promote.mjs bouldergeist --yes      # does it
 *   node ci/scripts/host/promote.mjs bouldergeist --yes --no-sync   # old host is dead: go with the last sync
 *   node ci/scripts/host/promote.mjs bouldergeist --yes --skip-runners   # move traffic only; CI keeps deploying
 *     to the old host (e.g. the new one has no runners yet, or gh isn't signed in where this runs)
 *
 * Order: stop the tunnel and crons on the old host (no more writes there), final sync to the new host (files and
 * databases), crons + tunnel on the new host, move the runner label, health checks. If the new host fails the
 * checks, the tunnel and crons go back to the old host.
 *
 * Needs SSH to both hosts and `gh` signed in as someone who administers the repos in ci/runners.json.
 */
import { spawnSync } from "node:child_process";
import { HOST_STATE, PROD_LABEL, host, hosts, loadJson, log, parseArgs, run, runOk, runnerHost, runsTunnel, step } from "./lib.mjs";
import { syncHosts } from "./sync.mjs";

const TUNNEL = "/opt/services/infra/cloudflared";
const TUNNEL_ENV = "/opt/services/data/app-env/cloudflared.env";

function stopTunnelAndCrons(h) {
  run(h, `sudo docker stop cloudflared-autoheal cloudflared >/dev/null 2>&1 || true
sudo mkdir -p ${HOST_STATE}/cron
for f in /etc/cron.d/wl-*; do [ -e "$f" ] && sudo mv "$f" ${HOST_STATE}/cron/; done; true`);
  log(`${h.name}: tunnel stopped, crons parked in ${HOST_STATE}/cron`);
}

function startTunnelAndCrons(h) {
  run(h, `for f in ${HOST_STATE}/cron/wl-*; do [ -e "$f" ] && sudo install -m 644 "$f" /etc/cron.d/; done
cd ${TUNNEL} && sudo docker compose -p cloudflared -f compose.yml --env-file ${TUNNEL_ENV} up -d --quiet-pull 2>&1 | tail -1
for i in $(seq 1 45); do [ "$(sudo docker inspect -f '{{.State.Health.Status}}' cloudflared 2>/dev/null)" = healthy ] && exit 0; sleep 2; done
echo "cloudflared did not become healthy" >&2; exit 1`);
  log(`${h.name}: crons installed, tunnel connected`);
}

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Moves the `glados` label (what production jobs run on) from `from`'s runners to `to`'s, repo by repo. */
function moveRunnerLabel(fromName, to, { dryRun }) {
  const repos = loadJson("ci/runners.json").repos.map((r) => r.repo);
  const pinned = new Set(to.skipRepos || []);
  for (const repo of repos) {
    if (pinned.has(repo)) {
      log(`  ${repo}: stays on ${fromName} (needs its hardware)`);
      continue;
    }
    const runners = JSON.parse(gh(["api", `repos/${repo}/actions/runners?per_page=100`, "--jq", ".runners"]) || "[]");
    const mine = runners.filter((r) => runnerHost(r) === to.name);
    if (!mine.length) {
      log(`  ${repo}: ⚠ no runner on ${to.name}; its deploy jobs will wait. Register one: register.mjs --host ${to.name}`);
      continue;
    }
    const plan = [];
    for (const r of runners) {
      const has = r.labels.some((l) => l.name === PROD_LABEL);
      if (runnerHost(r) === to.name && !has) plan.push(["add", r]);
      if (runnerHost(r) !== to.name && has) plan.push(["remove", r]);
    }
    log(`  ${repo}: ${plan.map(([a, r]) => `${a} ${r.name}`).join(", ") || "already on " + to.name}`);
    if (dryRun) continue;
    for (const [action, r] of plan) {
      if (action === "add") gh(["api", "-X", "POST", `repos/${repo}/actions/runners/${r.id}/labels`, "-f", `labels[]=${PROD_LABEL}`]);
      else {
        gh(["api", "-X", "DELETE", `repos/${repo}/actions/runners/${r.id}/labels/${PROD_LABEL}`]);
        // Old glados runners predate host labels; tag them so they're found again when glados is promoted back.
        if (!r.labels.some((l) => l.name.startsWith("host-")) && runnerHost(r)) {
          gh(["api", "-X", "POST", `repos/${repo}/actions/runners/${r.id}/labels`, "-f", `labels[]=host-${runnerHost(r)}`]);
        }
      }
    }
  }
}

function healthy(h) {
  step(`${h.name}: health checks`);
  const checks = loadJson("hosts/hosts.json").publicChecks || [];
  const gate = run(h, `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Host: radio.joed.dev' http://127.0.0.1/ || true`, { quiet: true });
  let ok = gate.startsWith("302 https://auth.joed.dev/oauth2/start");
  log(`  local Traefik + sign-in gate: ${ok ? "ok" : `FAIL (${gate})`}`);
  for (const url of checks) {
    let code = "";
    for (let i = 0; i < 10 && code !== "200"; i++) {
      code = spawnSync("curl", ["-s", "-o", "/dev/null", "-m", "15", "-w", "%{http_code}", url], { encoding: "utf8" }).stdout;
      if (code !== "200") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
    log(`  ${url}: ${code}`);
    if (code !== "200") ok = false;
  }
  return ok;
}

const args = parseArgs(process.argv.slice(2), { yes: "bool", noSync: "bool", dryRun: "bool", skipRunners: "bool" });
const target = args._[0] && host(args._[0]);
if (!target) {
  console.error("Usage: promote.mjs <host> [--yes] [--no-sync]   (without --yes it only shows the plan)");
  process.exit(2);
}
const dryRun = !args.yes || args.dryRun;

try {
  if (!runOk(target, "true")) throw new Error(`Can't reach ${target.name} over SSH`);
  const others = hosts().filter((h) => h.name !== target.name);
  const otherTunnels = others.filter((h) => runOk(h, "true") && runsTunnel(h));
  step(`promote ${target.name}${dryRun ? " (plan only; add --yes to do it)" : ""}`);
  if (runsTunnel(target)) {
    // Already active. Clean up a second tunnel (e.g. the old host came back up with its own) and the label.
    log(`${target.name} is already active.`);
    for (const h of otherTunnels) {
      log(`${h.name} ALSO runs the tunnel: ${dryRun ? "would stop it and park its crons" : "stopping it"}`);
      if (!dryRun) stopTunnelAndCrons(h);
    }
    log("runner label:");
    moveRunnerLabel(otherTunnels[0]?.name || others[0]?.name || "", target, { dryRun });
    process.exit(0);
  }
  if (otherTunnels.length > 1) throw new Error(`${otherTunnels.map((h) => h.name).join(" and ")} both run the tunnel; promote one of them first`);
  const current = otherTunnels[0] || null;
  log(`active now: ${current ? current.name : "none reachable"}`);

  log(`1. ${current ? `${current.name}: stop the tunnel and park the crons (public sites are down until step 3)` : "no active host to stop"}`);
  log(`2. ${current && !args.noSync ? `final sync ${current.name} → ${target.name} (files + databases)` : "no sync: the new host serves what it already has"}`);
  log(`3. ${target.name}: install crons, start the tunnel`);
  if (args.skipRunners) log(`4. runner label stays where it is (--skip-runners): deploy jobs keep going to the old host`);
  else {
    log(`4. move the "${PROD_LABEL}" runner label to ${target.name}'s runners:`);
    moveRunnerLabel(current?.name || "glados", target, { dryRun: true });
  }
  log("5. health checks; on failure, hand everything back");
  if (dryRun) process.exit(0);

  if (current) stopTunnelAndCrons(current);
  try {
    if (current && !args.noSync) syncHosts(current, target);
    startTunnelAndCrons(target);
    if (!healthy(target)) throw new Error("health checks failed");
  } catch (err) {
    console.error(`\n${err.message}; handing traffic back${current ? ` to ${current.name}` : ""}`);
    stopTunnelAndCrons(target);
    if (current) startTunnelAndCrons(current);
    process.exit(1);
  }
  if (!args.skipRunners) {
    step("runner label");
    moveRunnerLabel(current?.name || "glados", target, { dryRun: false });
  }
  for (const h of others) if (runOk(h, "true") && runsTunnel(h)) throw new Error(`${h.name} still runs the tunnel`);
  step(`${target.name} is active`);
} catch (err) {
  console.error(`\npromote failed: ${err.message}`);
  process.exit(1);
}

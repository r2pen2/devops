#!/usr/bin/env node
/**
 * Where the stack runs right now.
 *
 *   node ci/scripts/host/status.mjs             # each host: reachable, active?, containers, crons, power
 *   node ci/scripts/host/status.mjs --runners   # plus: which runners hold the production label, per repo
 *   node ci/scripts/host/status.mjs --data      # plus: every dataset on every host, side by side (spots divergence)
 *
 * Warns when two hosts run the tunnel (Cloudflare would split requests and the data would diverge) or none does.
 */
import { spawnSync } from "node:child_process";
import { measure } from "./datasets.mjs";
import { PROD_LABEL, datasets, hosts, loadJson, log, parseArgs, run, runOk, step } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), { runners: "bool", data: "bool" });
const all = hosts();
const up = all.filter((h) => runOk(h, "true"));
let active = [];

step("hosts");
for (const h of all) {
  if (!up.includes(h)) {
    log(`${h.name}: UNREACHABLE (${h.user}@${h.tailscale || h.name})`);
    continue;
  }
  const info = run(h, `tunnel=$( [ "$(sudo docker inspect -f '{{.State.Running}}' cloudflared 2>/dev/null)" = true ] && echo yes || echo no )
running=$(sudo docker ps -q | wc -l); stopped=$(sudo docker ps -aq -f status=exited | wc -l)
crons=$(ls /etc/cron.d/wl-* 2>/dev/null | xargs -r -n1 basename | tr '\\n' ' ')
power=""
for b in /sys/class/power_supply/BAT*; do [ -e "$b" ] && power="battery $(cat $b/capacity)% $(cat $b/status)"; done
echo "$tunnel|$running|$stopped|\${crons:-none}|\${power:-mains}|$(cut -d' ' -f1-3 /proc/loadavg)|$(free -m | awk '/Mem:/ { print $3 "/" $2 " MB" }')"`, { quiet: true });
  const [tunnel, running, stopped, crons, power, load, mem] = info.split("|");
  if (tunnel === "yes") active.push(h.name);
  log(`${h.name}: ${tunnel === "yes" ? "ACTIVE (runs the tunnel)" : "standby"}`);
  log(`  containers: ${running} running, ${stopped} stopped · crons: ${crons} · load ${load} · memory ${mem} · ${power}`);
}
if (active.length > 1) log(`\n⚠ ${active.join(" and ")} both run the tunnel: requests are split between them. Stop one (promote does this).`);
if (!active.length) log("\n⚠ No reachable host runs the tunnel: the public sites are down. Promote one: promote.mjs <host> --yes");

if (args.runners) {
  step(`runners holding "${PROD_LABEL}" (production jobs run there)`);
  for (const { repo } of loadJson("ci/runners.json").repos) {
    const r = spawnSync("gh", ["api", `repos/${repo}/actions/runners?per_page=100`, "--jq", ".runners"], { encoding: "utf8" });
    if (r.status !== 0) {
      log(`  ${repo}: can't list runners (${(r.stderr || "").trim().split("\n")[0]})`);
      continue;
    }
    const prod = JSON.parse(r.stdout || "[]").filter((x) => x.labels.some((l) => l.name === PROD_LABEL));
    log(`  ${repo}: ${prod.map((x) => `${x.name} (${x.status})`).join(", ") || "⚠ none: deploys will wait"}`);
  }
}

if (args.data) {
  step("datasets on each host");
  for (const ds of datasets()) {
    log(`  ${ds.name}`);
    for (const h of up) log(`    ${h.name.padEnd(14)} ${measure(h, ds) || "-"}`);
  }
}

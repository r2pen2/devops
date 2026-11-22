#!/usr/bin/env node
/**
 * Which host serves which site. hosts.json `placement` maps a hostname to the host that serves it
 * (e.g. "radio.joed.dev": "glados", where the speaker is wired). Every other site is served by the active host
 * (the one running the tunnel), as before. Projects in hosts.json `pinned` run only on their site's host: --apply
 * starts them there and stops them everywhere else (see matchPinned; the watchdog handles a dead owner).
 *
 *   node ci/scripts/host/placement.mjs            # shows what each host's Traefik would get
 *   node ci/scripts/host/placement.mjs --apply    # writes it on every reachable host
 *
 * Writes /opt/services/infra/traefik/dynamic/placement.yml on every host (Traefik reloads it; no restart):
 * - For each placed site on ANOTHER host: a top-priority router sending the whole hostname to that host's Traefik
 *   over Tailscale, which applies its own routes and sign-in. If that host is down (health check on the path
 *   below) and this host has its own route for the site, it falls back to the local copy (for a pinned app, once
 *   the watchdog has started it here).
 * - On every host: GET /.well-known/wl-served-by on any site answers 418 with `X-Served-By: <host>`, so
 *   site-probe (and you, with curl -I) can see which machine actually served a site.
 * The active host's routes are what matter; the others hold the same file so a promote or takeover just works.
 * The file before each change is kept in /opt/services/infra/backups/traefik-placement/; a failed check restores it.
 */
import { pathToFileURL } from "node:url";
import { HOST_STATE, SERVICES, hosts, loadJson, log, parseArgs, pinned, run, runOk, stamp, step } from "./lib.mjs";
import { composeArgs, ensureImages } from "./sync.mjs";

const DYNAMIC = `${SERVICES}/infra/traefik/dynamic/placement.yml`;
const BACKUPS = `${SERVICES}/infra/backups/traefik-placement`;
export const SERVED_BY_PATH = "/.well-known/wl-served-by";
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

/** Routers of the host's Traefik, through its internal API (open to Docker-network addresses only). */
export function traefikRouters(h) {
  const out = run(h, `ip=$(sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' traefik | cut -d' ' -f1)
curl -sf "http://$ip:8080/api/http/routers?per_page=1000"`, { quiet: true });
  return JSON.parse(out || "[]");
}

/** The local service a site would get without placement: its plainest router (shortest rule) naming the host. */
function localService(routers, site) {
  const mine = routers.filter((r) => r.provider !== "file" || !r.name.startsWith("place-"))
    .filter((r) => (r.entryPoints || []).includes("web") && r.rule.includes(`Host(\`${site}\`)`))
    .sort((a, b) => a.rule.length - b.rule.length);
  if (!mine.length) return null;
  const svc = mine[0].service;
  return svc.includes("@") ? svc : `${svc}@${mine[0].provider}`;
}

export function placementFor(h, { placement, ips, routers }) {
  const routersOut = {
    "wl-served-by": {
      rule: `Path(\`${SERVED_BY_PATH}\`)`,
      priority: 90000,
      entryPoints: ["web"],
      middlewares: ["wl-served-by"],
      service: "noop@internal",
    },
  };
  const services = {};
  const summary = [];
  for (const [site, owner] of Object.entries(placement)) {
    if (site.startsWith("$")) continue;
    if (owner === h.name) {
      summary.push(`${site}: served here`);
      continue;
    }
    if (!ips[owner]) throw new Error(`placement: ${site} → ${owner}, but ${owner} has no Tailscale address`);
    const name = `place-${slug(site)}`;
    services[`${name}-remote`] = {
      loadBalancer: {
        servers: [{ url: `http://${ips[owner]}:80` }],
        passHostHeader: true,
        // The owner's Traefik answers this path itself (418), so it checks the host, not the app.
        healthCheck: { path: SERVED_BY_PATH, interval: "10s", timeout: "3s", status: 418 },
      },
    };
    // No fallback to an app this host can't run (its `skip` list): that local route has nothing behind it.
    let fallback = localService(routers, site);
    if (fallback && (h.skip || []).includes(fallback.split("@")[0])) fallback = null;
    let service = `${name}-remote`;
    if (fallback) {
      services[name] = { failover: { service: `${name}-remote`, fallback } };
      service = name;
    }
    // Above every app route for the hostname (Traefik's default priority is the rule's length) and the
    // served-by path, so the owner answers that too.
    routersOut[name] = { rule: `Host(\`${site}\`)`, priority: 100000, entryPoints: ["web"], service };
    summary.push(`${site}: → ${owner} (${ips[owner]})${fallback ? `, else local ${fallback}` : ", nothing local to fall back to"}`);
  }
  const doc = {
    http: {
      routers: routersOut,
      middlewares: { "wl-served-by": { headers: { customResponseHeaders: { "X-Served-By": h.name } } } },
      ...(Object.keys(services).length ? { services } : {}),
    },
  };
  const text = `# Generated by r2pen2/devops ci/scripts/host/placement.mjs from hosts/hosts.json "placement". Don't edit:\n# re-run placement.mjs --apply. JSON is YAML.\n${JSON.stringify(doc, null, 2)}\n`;
  return { text, summary };
}

export function tailscaleIps(list) {
  const ips = {};
  for (const h of list) {
    const ip = run(h, "tailscale ip -4 2>/dev/null | head -1 || true", { quiet: true, allowFail: true }).trim();
    if (ip) ips[h.name] = ip;
  }
  return ips;
}

function apply(h, text) {
  const enabledBefore = traefikRouters(h).filter((r) => r.status === "enabled" && !/^(place-|wl-served-by)/.test(r.name)).length;
  const b64 = Buffer.from(text).toString("base64");
  run(h, `sudo mkdir -p ${BACKUPS}
[ -f ${DYNAMIC} ] && sudo cp ${DYNAMIC} ${BACKUPS}/placement-${stamp()}.yml
{ ls -1t ${BACKUPS}/placement-*.yml 2>/dev/null || true; } | tail -n +21 | xargs -r sudo rm -f
echo ${b64} | base64 -d | sudo tee ${DYNAMIC}.new >/dev/null && sudo mv ${DYNAMIC}.new ${DYNAMIC}`);
  // Traefik reloads within a couple of seconds. Check it took the file and answers as this host.
  let got = "";
  for (let i = 0; i < 10 && got !== h.name; i++) {
    run(h, "sleep 1", { quiet: true });
    got = run(h, `curl -s -D - -o /dev/null -H 'Host: placement-check.invalid' http://127.0.0.1${SERVED_BY_PATH} | tr -d '\\r' | awk -F': ' 'tolower($1)=="x-served-by"{print $2}'`, { quiet: true, allowFail: true });
  }
  const after = traefikRouters(h);
  const broken = after.filter((r) => r.provider === "file" && (r.name.startsWith("place-") || r.name.startsWith("wl-served-by")) && r.status !== "enabled");
  // A bad file can take the rest of the file provider (the sign-in middleware) with it: compare the other routes.
  const enabledAfter = after.filter((r) => r.status === "enabled" && !/^(place-|wl-served-by)/.test(r.name)).length;
  if (enabledAfter < enabledBefore) broken.push({ name: "other routes", error: [`${enabledBefore} enabled before, ${enabledAfter} after`] });
  if (got !== h.name || broken.length) {
    run(h, `last=$( { ls -1t ${BACKUPS}/placement-*.yml 2>/dev/null || true; } | head -1); if [ -n "$last" ]; then sudo cp "$last" ${DYNAMIC}; else sudo rm -f ${DYNAMIC}; fi`);
    throw new Error(`${h.name}: Traefik didn't take placement.yml (served-by: "${got}", broken: ${broken.map((r) => `${r.name}: ${(r.error || []).join("; ")}`).join(", ") || "none"}); restored the previous file`);
  }
  log(`  applied; ${SERVED_BY_PATH} answers "${got}"`);
}

/** How docker compose runs `project` on h, from its containers (running or not); null if it has none there. */
function composeOf(h, project) {
  const line = run(h, `sudo docker ps -a --filter label=com.docker.compose.project=${project} --format '{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.Label "com.docker.compose.project.environment_file"}}' | head -1`, { quiet: true });
  if (!line) return null;
  const [dir, files, envFile] = line.split("|");
  return { project, dir, files: files.split(",").filter(Boolean), envFile: envFile || "" };
}

/**
 * Pinned projects (hosts.json `pinned`): running on their owner, created but stopped on every other host. Also
 * writes what the watchdog needs to take one over when its owner dies: host-state/pinned.tsv, and the planned
 * placement.yml to put back when the owner returns. Leaves a host alone for a project whose owner is unreachable
 * (it may be serving it after a takeover).
 */
function matchPinned(h, reachable, ips, text, { dryRun }) {
  const rows = [];
  for (const p of pinned()) {
    const owner = reachable.find((x) => x.name === p.owner);
    const here = composeOf(h, p.project);
    const c = here || (owner && composeOf(owner, p.project));
    if (c) rows.push([p.site, p.owner, ips[p.owner] || "", p.project, c.dir, composeArgs(c), p.refresh.join(",")].join("\t"));
    if (!owner) {
      log(`  ${p.project}: ${p.owner} unreachable, left as it is here`);
      continue;
    }
    if (!c) {
      log(`  ${p.project}: runs on neither ${h.name} nor ${p.owner}, nothing to do`);
      continue;
    }
    if (dryRun) {
      log(`  ${p.project}: would ${p.owner === h.name ? "run here (its host)" : `be stopped here (pinned to ${p.owner})`}`);
      continue;
    }
    if (!runOk(h, `sudo test -f ${c.files[0] || `${c.dir}/compose.yml`}`)) {
      log(`  ${p.project}: no compose file on ${h.name} (sync it from ${p.owner} first)`);
      continue;
    }
    if (p.owner === h.name) {
      run(h, `cd ${c.dir} && sudo docker compose ${composeArgs(c)} up -d --quiet-pull 2>&1 | tail -1`);
      log(`  ${p.project}: running here (its host)`);
    } else {
      if (!here) {
        ensureImages(owner, h, c);
        run(h, `cd ${c.dir} && sudo docker compose ${composeArgs(c)} create --quiet-pull 2>&1 | tail -1`);
      }
      run(h, `cd ${c.dir} && sudo docker compose ${composeArgs(c)} stop 2>&1 | tail -1`);
      log(`  ${p.project}: stopped here (pinned to ${p.owner})`);
    }
  }
  if (dryRun) return;
  const tsv = rows.length ? `${rows.join("\n")}\n` : "";
  run(h, `sudo mkdir -p ${HOST_STATE}/watchdog
echo ${Buffer.from(tsv).toString("base64")} | base64 -d | sudo tee ${HOST_STATE}/pinned.tsv >/dev/null
echo ${Buffer.from(text).toString("base64")} | base64 -d | sudo tee ${HOST_STATE}/placement.planned.yml >/dev/null
# Placement is what it should be again: any takeover the watchdog did here is over.
sudo rm -f ${HOST_STATE}/watchdog/pinned-*`);
}

export function applyPlacement({ dryRun = false, only = null } = {}) {
  const { placement = {} } = loadJson("hosts/hosts.json");
  const all = hosts();
  const reachable = all.filter((h) => runOk(h, "true"));
  const ips = tailscaleIps(reachable);
  for (const h of reachable) {
    if (only && h.name !== only) continue;
    step(`${h.name}: placement`);
    const { text, summary } = placementFor(h, { placement, ips, routers: traefikRouters(h) });
    summary.forEach((l) => log(`  ${l}`));
    if (!dryRun) apply(h, text);
    matchPinned(h, reachable, ips, text, { dryRun });
  }
  for (const h of all.filter((x) => !reachable.includes(x))) log(`${h.name}: unreachable, not updated (run --apply again when it's back)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), { apply: "bool", host: "string" });
  try {
    applyPlacement({ dryRun: !args.apply, only: args.host || null });
    if (!args.apply) log("\n(plan only; add --apply to write it)");
  } catch (err) {
    console.error(`\nplacement failed: ${err.message}`);
    process.exit(1);
  }
}

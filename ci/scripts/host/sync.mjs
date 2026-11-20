#!/usr/bin/env node
/**
 * Mirror one host's stack onto a standby host, so it can take over (see promote.mjs).
 *
 *   node ci/scripts/host/sync.mjs --from glados --to bouldergeist --dry-run
 *   node ci/scripts/host/sync.mjs --from glados --to bouldergeist
 *
 * Runs from anywhere that can SSH to both hosts (either host, or a laptop on the tailnet). On the target it:
 *   1. mirrors /opt/services (compose files, env files, scripts, app data) with rsync --delete, leaving out QA
 *      previews, backups, telemetry and the raw database directories (hosts/datasets.json `rawDirs`);
 *   2. stages the source's crons in /opt/services/host-state/cron (installed only when the host is promoted),
 *      and copies root's registry login (GHCR);
 *   3. creates the shared docker networks, pulls every image (streaming ones that can't be pulled, like local
 *      builds, straight from the source), and starts every compose project the source runs, except the tunnel
 *      (only the active host runs cloudflared) and the projects the target's `skip` lists;
 *   4. copies the Mongo and Postgres databases logically (dump on the source, restore on the target).
 *
 * Refuses to write over the ACTIVE host (the one running cloudflared). Env files go host to host over SSH only.
 */
import { pathToFileURL } from "node:url";
import { copy as copyDataset } from "./datasets.mjs";
import { HOST_STATE, SERVICES, datasets, guardTarget, host, loadJson, log, parseArgs, run, runOk, sshCmd, sshTarget, step } from "./lib.mjs";

/** Never mirrored: per-PR previews, backups, archives, and fast-changing telemetry. Paths relative to /opt/services. */
const EXCLUDES = [
  "/host-state/",
  "/infra/backups/",
  "/data/backups/",
  "/data/archive/",
  "/data/app-assets/qa/",
  "/data/app-env/qa/",
  "/data/app-assets/loki/",
  "/data/app-assets/tempo/",
  "/data/app-assets/otel-collector/",
  "/data/app-assets/liveness/",
];

/** The source's compose projects, as `docker compose` started them: [{ project, dir, files, envFile }]. */
export function projectsOn(h) {
  const rows = run(h, `sudo docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}|{{.Label "com.docker.compose.project.environment_file"}}' | sort -u`, { quiet: true });
  const byProject = new Map();
  for (const line of rows.split("\n").filter(Boolean)) {
    const [project, dir, files, envFile] = line.split("|");
    if (!project || !dir.startsWith(`${SERVICES}/`) || project.startsWith("qa-pr-")) continue;
    const prev = byProject.get(project);
    byProject.set(project, { project, dir, files: files.split(",").filter(Boolean), envFile: envFile || prev?.envFile || "" });
  }
  // Infra first (Traefik, the sign-in, databases), then apps.
  return [...byProject.values()].sort((a, b) => Number(a.dir.includes("/apps/")) - Number(b.dir.includes("/apps/")) || a.project.localeCompare(b.project));
}

export const composeArgs = (p) => `-p ${p.project} --project-directory ${p.dir} ${p.files.map((f) => `-f ${f}`).join(" ")}${p.envFile ? ` --env-file ${p.envFile}` : ""}`;

function ensureBasics(to) {
  step(`${to.name}: prerequisites`);
  const missing = run(to, `for t in docker rsync node; do command -v $t >/dev/null || echo $t; done; sudo test -d ${SERVICES} || echo ${SERVICES}`, { quiet: true });
  if (missing) throw new Error(`${to.name} is missing: ${missing.replace(/\n/g, ", ")}. Run ci/scripts/host/bootstrap.sh there first.`);
  log("docker, rsync, node and /opt/services are there");
}

function mirrorFiles(from, to, { dryRun }) {
  step(`${from.name} → ${to.name}: mirror ${SERVICES}${dryRun ? " (dry run)" : ""}`);
  const raw = loadJson("hosts/datasets.json").rawDirs.map((d) => `/${d}/`);
  const excludes = [...EXCLUDES, ...raw].map((e) => `--exclude='${e}'`).join(" ");
  const ssh = sshCmd(from);
  const remote = `${sshTarget(from)}`;
  const rsync = `sudo rsync -aH --numeric-ids --delete ${dryRun ? "--dry-run --stats" : "--stats"} -e "sudo -u $(id -un) ${ssh.replace(/ \S+$/, "")}" --rsync-path="sudo rsync"`;
  const out = run(to, `sudo mkdir -p ${SERVICES} ${HOST_STATE}/cron /root/.docker
${rsync} ${excludes} '${remote}:${SERVICES}/' '${SERVICES}/' | grep -E 'Number of (regular )?files transferred|Total transferred file size|Number of deleted files' || true
# The source's crons wait here until this host is promoted; root's registry login comes along so GHCR pulls work.
${rsync} --include='wl-*' --exclude='*' '${remote}:/etc/cron.d/' '${HOST_STATE}/cron/' >/dev/null
${dryRun ? "" : `${rsync.replace("--delete ", "")} '${remote}:/root/.docker/config.json' /root/.docker/config.json >/dev/null 2>&1 || echo "no registry login on ${from.name}"`}`);
  log(out || "(no changes)");
}

function ensureNetworks(from, to) {
  // Networks made by hand (not by a compose project) that compose files join as `external`, e.g. `proxy`.
  const names = run(from, `sudo docker network ls --format '{{.Name}}|{{.Label "com.docker.compose.network"}}' | awk -F'|' '$2 == "" && $1 !~ /^(bridge|host|none)$/ { print $1 }'`, { quiet: true }).split("\n").filter(Boolean);
  for (const n of names) run(to, `sudo docker network inspect ${n} >/dev/null 2>&1 || sudo docker network create ${n} >/dev/null`);
  log(`networks: ${names.join(", ") || "none"}`);
}

function ensureImages(from, to, p) {
  const images = run(to, `cd ${p.dir} && sudo docker compose ${composeArgs(p)} config --images`, { quiet: true }).split("\n").filter(Boolean);
  for (const img of images) {
    if (runOk(to, `sudo docker image inspect '${img}' >/dev/null 2>&1`)) continue;
    if (runOk(to, `sudo docker pull -q '${img}' >/dev/null 2>&1`)) continue;
    log(`  ${img}: not pullable, streaming it from ${from.name}`);
    run(to, `${sshCmd(from)} "sudo docker save '${img}'" | sudo docker load -q`);
  }
}

export function startProjects(from, to, projects) {
  step(`${to.name}: start ${projects.length} compose projects`);
  for (const p of projects) {
    ensureImages(from, to, p);
    run(to, `cd ${p.dir} && sudo docker compose ${composeArgs(p)} up -d --quiet-pull 2>&1 | tail -2`);
    log(`  ${p.project}: up`);
  }
}

function waitForDatabase(to, ds) {
  const ping = ds.type === "mongo"
    ? `sudo docker exec ${ds.container} mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok'`
    : `sudo docker exec ${ds.container} sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`;
  run(to, `for i in $(seq 1 60); do ${ping} >/dev/null 2>&1 && exit 0; sleep 2; done; echo "${ds.container} not ready" >&2; exit 1`);
}

export function copyDatabases(from, to) {
  step(`${from.name} → ${to.name}: databases (dump and restore)`);
  for (const ds of datasets().filter((d) => d.type === "mongo" || d.type === "postgres")) {
    const onBoth = runOk(from, `sudo docker inspect ${ds.container} >/dev/null 2>&1`) && runOk(to, `sudo docker inspect ${ds.container} >/dev/null 2>&1`);
    if (!onBoth) {
      log(`  ${ds.name}: not running on both hosts, skipped`);
      continue;
    }
    waitForDatabase(to, ds);
    copyDataset(from, to, ds);
    log(`  ${ds.name}: copied`);
  }
}

export function syncHosts(from, to, { dryRun = false, overwriteActive = false, skipData = false } = {}) {
  if (from.name === to.name) throw new Error("--from and --to are the same host");
  for (const h of [from, to]) if (!runOk(h, "true")) throw new Error(`Can't reach ${h.name} (${sshTarget(h)}) over SSH`);
  guardTarget(to, { overwriteActive });
  ensureBasics(to);
  mirrorFiles(from, to, { dryRun });

  const skip = new Set([...(to.skip || []), "cloudflared"]);
  const projects = projectsOn(from).filter((p) => !skip.has(p.project));
  if (dryRun) {
    step(`${to.name}: would start ${projects.length} projects`);
    log(projects.map((p) => p.project).join(", "));
    log(`skipped on ${to.name}: ${[...skip].join(", ")}`);
    return;
  }
  ensureNetworks(from, to);
  startProjects(from, to, projects);
  if (!skipData) copyDatabases(from, to);
  step("done");
  log(run(to, `sudo docker ps --format '{{.Names}}' | wc -l`, { quiet: true }) + ` containers running on ${to.name}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), { from: "string", to: "string", dryRun: "bool", overwriteActive: "bool", skipData: "bool" });
  if (!args.from || !args.to) {
    console.error("Usage: sync.mjs --from <host> --to <host> [--dry-run] [--skip-data] [--overwrite-active]");
    process.exit(2);
  }
  try {
    syncHosts(host(args.from), host(args.to), args);
  } catch (err) {
    console.error(`\nsync failed: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Shared helpers for the host scripts (sync, promote, status, data-copy, data-restore).
 *
 * A "host" is a Linux environment with Docker that runs the joed.dev stack: glados natively, bouldergeist inside
 * WSL2, a Mac inside OrbStack/Lima. Hosts reach each other over Tailscale SSH, by the names in hosts/hosts.json.
 *
 * The ACTIVE host is whichever one runs the cloudflared container: that's where public traffic lands. It is never
 * stored in a file, so the guards below can't go stale. Standbys run everything else, with no tunnel and no crons.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "../../..");
export const SERVICES = "/opt/services";
/** Per-host state that sync never copies: the crons a standby holds until it's promoted. */
export const HOST_STATE = `${SERVICES}/host-state`;
export const SNAPSHOTS = `${SERVICES}/data/backups/data-copy`;
/** The runner label production jobs use (`runs-on: [self-hosted, glados]`). Promote moves it between hosts. */
export const PROD_LABEL = "glados";

export function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
}

export function hosts() {
  return loadJson("hosts/hosts.json").hosts;
}

export function host(name) {
  const h = hosts().find((x) => x.name === name);
  if (!h) throw new Error(`Unknown host "${name}". Known: ${hosts().map((x) => x.name).join(", ")} (hosts/hosts.json)`);
  return h;
}

export function datasets() {
  return loadJson("hosts/datasets.json").datasets;
}

/** True when this process runs on that host (so commands run locally instead of over SSH). */
export function isLocal(h) {
  const me = (process.env.HOST_NAME || os.hostname()).toLowerCase();
  return me === h.name.toLowerCase() || me === (h.tailscale || "").toLowerCase();
}

/** How to reach a host: `address` (e.g. a LAN IP while it isn't on the tailnet yet), else its Tailscale name. */
export const sshTarget = (h) => `${h.user}@${h.address || h.tailscale || h.name}`;
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new"];
/**
 * The ssh command line, as a string, for scripts that run ON one host and reach ANOTHER. Scripts reach a host on
 * ssh's stdin (run() pipes them to `bash -s`), so a nested ssh that only produces output must not read stdin:
 * it would swallow the rest of the script, which then ends "successfully" without running it. That is how
 * every Postgres copy silently did nothing. Use `{ stdin: true }` only when the remote side reads stdin
 * (rsync's transport).
 */
export const sshCmd = (h, { stdin = false } = {}) => `ssh ${stdin ? "" : "-n "}${SSH_OPTS.join(" ")} ${sshTarget(h)}`;

/**
 * Runs a bash script on a host (locally, or over SSH) and returns stdout. The script goes over stdin, so it never
 * needs shell quoting. Throws on a non-zero exit unless allowFail.
 */
export function run(h, script, { allowFail = false, quiet = false, timeoutMs = 60 * 60 * 1000 } = {}) {
  const full = `set -euo pipefail\n${script}`;
  const [cmd, args] = isLocal(h) ? ["bash", ["-s"]] : ["ssh", [...SSH_OPTS, sshTarget(h), "bash -s"]];
  const r = spawnSync(cmd, args, { input: full, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
  const out = (r.stdout || "").trimEnd();
  if (!quiet && r.stderr?.trim()) process.stderr.write(r.stderr.replace(/^/gm, `  [${h.name}] `));
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${h.name}: command failed (exit ${r.status ?? r.signal}): ${(r.stderr || out).trim().split("\n").slice(-3).join(" | ")}`);
  }
  return out;
}

/** Runs a quick check; true if it exits 0. Also how reachability is tested (`runOk(h, "true")`). */
export function runOk(h, script) {
  try {
    run(h, script, { quiet: true, timeoutMs: 20000 });
    return true;
  } catch {
    return false;
  }
}

/** Is the tunnel connector running on this host? That's what makes a host active. */
export const runsTunnel = (h) => runOk(h, `[ "$(sudo docker inspect -f '{{.State.Running}}' cloudflared 2>/dev/null)" = true ]`);

/**
 * Refuses to overwrite the active host's data unless explicitly told to. Overwriting live data is how two
 * diverged copies lose the newer writes.
 */
export function guardTarget(to, { overwriteActive = false } = {}) {
  if (!overwriteActive && runsTunnel(to)) {
    throw new Error(`${to.name} is the ACTIVE host (it runs the tunnel). Refusing to overwrite it. Pass --overwrite-active if you really mean to.`);
  }
}

export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (spec[key] === "bool") out[key] = true;
    else if (spec[key] === "string") out[key] = argv[++i];
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

/** Which host a GitHub runner lives on: its `host-<name>` label, or (for the original runners) a glados name. */
export function runnerHost(r) {
  const tag = r.labels.map((l) => l.name).find((l) => l.startsWith("host-"));
  if (tag) return tag.slice(5);
  return /^glados(-|$)/.test(r.name) ? "glados" : null;
}

export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
export const log = (msg) => console.log(msg);
export const step = (msg) => console.log(`\n== ${msg}`);

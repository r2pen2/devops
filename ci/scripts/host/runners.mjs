#!/usr/bin/env node
/**
 * Give a host its GitHub Actions runners: one per repo in ci/runners.json, named `<host>-<repo>` and labelled
 * `self-hosted,host-<host>`. They take no production jobs until promote.mjs moves the `glados` label to them.
 *
 *   node ci/scripts/host/runners.mjs --host bouldergeist --dry-run
 *   node ci/scripts/host/runners.mjs --host bouldergeist
 *
 * Runs on the controller (the machine running these scripts), which must have `gh` signed in as someone who
 * administers the repos: it mints the short-lived registration tokens and sends each one to the host over SSH, so
 * the host never holds a GitHub token. On the host: downloads the runner once, configures one directory per repo
 * (~/actions-runner-<repo>), installs it as a systemd service. Skips runners already online. sync.mjs calls this.
 * Repos in the host's `skipRepos` (they drive hardware the host lacks) get no runner.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { host, loadJson, log, parseArgs, run, step } from "./lib.mjs";

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout.trim();
}

/** True if this machine can mint runner tokens (gh installed and signed in). */
export function canRegisterRunners() {
  const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  return r.status === 0;
}

const short = (repo) => repo.split("/")[1].toLowerCase();

export function registerRunners(h, { dryRun = false } = {}) {
  step(`${h.name}: CI runners`);
  const skip = new Set(h.skipRepos || []);
  const repos = loadJson("ci/runners.json").repos.map((r) => r.repo).filter((r) => !skip.has(r));
  const label = `host-${h.name}`;
  const todo = [];
  for (const repo of repos) {
    const name = `${h.name}-${short(repo)}`;
    const existing = JSON.parse(gh(["api", `repos/${repo}/actions/runners?per_page=100`, "--jq", ".runners"]) || "[]").find((r) => r.name === name);
    if (existing?.status === "online") {
      log(`  ${repo}: ${name} online`);
      continue;
    }
    todo.push({ repo, name, dir: `actions-runner-${short(repo)}` });
    log(`  ${repo}: ${dryRun ? "would register" : "registering"} ${name}${existing ? " (offline, re-registering)" : ""}`);
  }
  if (dryRun || !todo.length) return todo.length;

  const version = gh(["api", "repos/actions/runner/releases/latest", "--jq", ".tag_name"]).replace(/^v/, "");
  const tarball = `actions-runner-linux-x64-${version}.tar.gz`;
  run(h, `mkdir -p ~/.cache/actions-runner
cd ~/.cache/actions-runner
[ -f ${tarball} ] || curl -fsSL -o ${tarball} https://github.com/actions/runner/releases/download/v${version}/${tarball}`);

  for (const { repo: listed, name, dir } of todo) {
    // A renamed repo still answers the API under its old name, but runner registration needs the current one.
    const repo = gh(["api", `repos/${listed}`, "--jq", ".full_name"]);
    const token = gh(["api", "-X", "POST", `repos/${repo}/actions/runners/registration-token`, "--jq", ".token"]);
    // The token travels in the script on stdin, not on a command line here. It expires within the hour.
    run(h, `D=~/${dir}
mkdir -p "$D" && cd "$D"
[ -f config.sh ] || tar -xzf ~/.cache/actions-runner/${tarball}
if [ -f .runner ]; then sudo ./svc.sh stop >/dev/null 2>&1 || true; sudo ./svc.sh uninstall >/dev/null 2>&1 || true; ./config.sh remove --token '${token}' >/dev/null 2>&1 || rm -f .runner .credentials .credentials_rsaparams; fi
./config.sh --unattended --url https://github.com/${repo} --token '${token}' --name ${name} --labels self-hosted,${label} --work _work --replace >/dev/null
sudo ./svc.sh install >/dev/null && sudo ./svc.sh start >/dev/null`, { quiet: true });
    log(`  ${repo}: ${name} registered`);
  }
  return todo.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), { host: "string", dryRun: "bool" });
  if (!args.host) {
    console.error("Usage: runners.mjs --host <name> [--dry-run]");
    process.exit(2);
  }
  try {
    if (!canRegisterRunners()) throw new Error("gh isn't signed in here; run this where `gh auth status` works");
    registerRunners(host(args.host), args);
  } catch (err) {
    console.error(`\nrunners failed: ${err.message}`);
    process.exit(1);
  }
}

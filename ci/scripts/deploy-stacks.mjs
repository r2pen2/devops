#!/usr/bin/env node
/**
 * Install the stacks in the calling repo's stacks.json onto glados and (re)start what changed.
 *
 *   node ci/scripts/deploy-stacks.mjs [--only traefik,grafana] [--dry-run]
 *
 * Two kinds of stack:
 *   compose (default)  { src, dest, envFile?, restart? }  a folder installed file by file into `dest`;
 *                      `up -d` if compose.yml changed, else restart `restart` services if a mounted file did.
 *   systemd            { kind: "systemd", src, files: { name: { to, mode? } }, units }  host files
 *                      (scripts, unit files) installed to absolute paths; daemon-reload, enable and restart.
 *
 * Per stack: compare each repo file with what's on glados; nothing differs → nothing happens. Otherwise
 * back up what's there to /opt/services/infra/backups/, install the changed files (files only on
 * glados are never touched), apply, wait for it to be running/healthy, and check that a gated host
 * still bounces to the joed.dev sign-in. Any failure puts the old files back and applies again.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyArg = args[args.indexOf("--only") + 1];
const only = args.includes("--only") && onlyArg && onlyArg !== "all" ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;

const { stacks } = JSON.parse(fs.readFileSync("stacks.json", "utf8"));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

function sh(cmd, cmdArgs, { quiet = false, allowFail = false } = {}) {
  if (!quiet) console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed: ${(err.stderr || err.message).trim()}`);
  }
}
const sudo = (...a) => sh("sudo", a);
const sudoOk = (...a) => sh("sudo", a, { quiet: true, allowFail: true }) !== null;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// Every file of a stack as { rel, src, to, mode }.
function filesOf(stack) {
  if (stack.kind === "systemd") {
    return Object.entries(stack.files).map(([rel, t]) => ({ rel, src: `${stack.src}/${rel}`, to: t.to, mode: t.mode || "644" }));
  }
  return walk(stack.src).map((f) => {
    const rel = path.relative(stack.src, f).split(path.sep).join("/");
    return { rel, src: `${stack.src}/${rel}`, to: `${stack.dest}/${rel}`, mode: "644" };
  });
}

function compose(stack, ...rest) {
  const env = stack.envFile ? ["--env-file", stack.envFile] : [];
  return ["docker", "compose", ...env, "-f", `${stack.dest}/compose.yml`, ...rest];
}

function apply(stack, changed) {
  if (stack.kind === "systemd") {
    sudo("systemctl", "daemon-reload");
    sudo("systemctl", "enable", ...stack.units);
    sudo("systemctl", "restart", ...stack.units);
    return;
  }
  if (changed.some((f) => f.rel === "compose.yml")) {
    sh("sudo", compose(stack, "pull"), { allowFail: true });
    sudo(...compose(stack, "up", "-d", "--remove-orphans"));
  } else if (stack.restart?.length && changed.length) {
    sudo(...compose(stack, "restart", ...stack.restart));
  }
}

function waitHealthy(stack) {
  let last = "";
  for (let i = 0; i < 40; i++) {
    if (stack.kind === "systemd") {
      last = stack.units.map((u) => `${u} ${sh("systemctl", ["is-active", u], { quiet: true, allowFail: true })?.trim() || "inactive"}`).join("\n");
      // Give a crash-looping unit a few seconds to show it.
      if (i >= 3 && !/ (inactive|failed|activating)$/m.test(last)) return console.log(last);
    } else {
      const out = sh("sudo", compose(stack, "ps", "-a", "--format", "{{.Name}} {{.State}} {{.Health}}"), { quiet: true, allowFail: true }) || "";
      const rows = out.trim().split("\n").filter(Boolean).map((l) => l.split(" "));
      last = out.trim();
      const bad = rows.filter(([, state, health]) => state !== "running" || health === "unhealthy");
      const starting = rows.filter(([, , health]) => health === "starting");
      if (rows.length && !bad.length && !starting.length) return console.log(last);
      if (bad.some(([, state]) => state === "exited" || state === "restarting") && i > 5) break;
    }
    sleep(3000);
  }
  throw new Error(`not healthy:\n${last}`);
}

function gateOk() {
  for (let i = 0; i < 10; i++) {
    const out = sh("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "-H", "Host: radio.joed.dev", "http://127.0.0.1/"], { quiet: true, allowFail: true }) || "";
    if (out.startsWith("302 https://auth.joed.dev/oauth2/start")) return true;
    sleep(2000);
  }
  return false;
}

let failed = false;
for (const [name, stack] of Object.entries(stacks)) {
  if (only && !only.has(name)) continue;
  const changed = filesOf(stack).filter((f) => !sudoOk("cmp", "-s", f.src, f.to));
  if (!changed.length) {
    console.log(`${name}: unchanged`);
    continue;
  }
  console.log(`::group::${name}: ${changed.map((f) => f.rel).join(", ")}`);
  for (const f of changed) console.log(sh("bash", ["-c", `sudo diff -u "${f.to}" "${f.src}" 2>/dev/null || true`], { quiet: true }) || `(new) ${f.to}`);
  if (dryRun) {
    console.log("::endgroup::");
    continue;
  }
  const backup = `/opt/services/infra/backups/${name}-${stamp}`;
  sudo("mkdir", "-p", backup);
  for (const f of changed) if (sudoOk("test", "-e", f.to)) sudo("install", "-D", "-m", f.mode, f.to, `${backup}/${f.rel}`);
  try {
    for (const f of changed) sudo("install", "-D", "-m", f.mode, f.src, f.to);
    apply(stack, changed);
    waitHealthy(stack);
    if (!gateOk()) throw new Error("radio.joed.dev no longer bounces to the sign-in");
    console.log(`${name}: deployed (backup ${backup})`);
  } catch (err) {
    failed = true;
    console.log(`::error::${name}: ${err.message}; restoring ${backup}`);
    for (const f of changed) {
      if (sudoOk("test", "-e", `${backup}/${f.rel}`)) sudo("install", "-m", f.mode, `${backup}/${f.rel}`, f.to);
      else sudo("rm", "-f", f.to);
    }
    try {
      if (stack.kind === "systemd" && !changed.some((f) => sudoOk("test", "-e", f.to))) sh("sudo", ["systemctl", "disable", "--now", ...stack.units], { allowFail: true });
      else apply(stack, changed);
    } catch (e) {
      console.log(`::error::${name}: re-applying after restore failed too: ${e.message}`);
    }
  }
  console.log("::endgroup::");
}
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * The host watchdog (watchdog.sh): every minute on every host. A standby takes over the sites when the active
 * host dies, and the dead host hands back on its own when it returns; both email. Read watchdog.sh for the rules.
 *
 *   node ci/scripts/host/watchdog.mjs install            # every reachable host (or --host <name>)
 *   node ci/scripts/host/watchdog.mjs log [--host x]     # recent watchdog log lines per host
 *   node ci/scripts/host/watchdog.mjs pause --minutes 30 # e.g. before restarting a host on purpose
 *   node ci/scripts/host/watchdog.mjs resume
 *   node ci/scripts/host/watchdog.mjs test-mail --host glados   # check it can email you
 *
 * Installs /opt/services/bin/host-watchdog, /opt/services/host-state/watchdog.env (this host's name, its peers,
 * the checks and alert address from hosts.json `watchdog`), and host-watchdog.timer (root). Re-run install after
 * changing hosts.json or watchdog.sh. Each host must reach the others as root over Tailscale SSH: install checks.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HOST_STATE, SERVICES, host, hosts, loadJson, log, parseArgs, repoRoot, run, runOk, sshTarget, step } from "./lib.mjs";

const UNIT = `[Unit]
Description=joed.dev host watchdog (fail over the public sites; see r2pen2/devops ci/scripts/host/watchdog.sh)
After=docker.service network-online.target

[Service]
Type=oneshot
ExecStart=${SERVICES}/bin/host-watchdog
TimeoutStartSec=300
`;
const TIMER = `[Unit]
Description=Run the joed.dev host watchdog every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
`;

const b64 = (s) => Buffer.from(s).toString("base64");
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function install(h) {
  step(`${h.name}: watchdog`);
  const { watchdog = {} } = loadJson("hosts/hosts.json");
  const peers = hosts().filter((p) => p.name !== h.name).map((p) => `${p.name}=${sshTarget(p)}`);
  const env = [
    `HOST_NAME=${shq(h.name)}`,
    `PEERS=${shq(peers.join(" "))}`,
    `CHECKS=${shq((watchdog.checks || []).join(" "))}`,
    `ALERT_TO=${shq(watchdog.alertTo || "")}`,
    "",
  ].join("\n");
  const script = fs.readFileSync(path.join(repoRoot, "ci/scripts/host/watchdog.sh"), "utf8").replace(/\r\n/g, "\n");
  run(h, `sudo mkdir -p ${SERVICES}/bin ${HOST_STATE}
echo ${b64(script)} | base64 -d | sudo tee ${SERVICES}/bin/host-watchdog >/dev/null && sudo chmod 755 ${SERVICES}/bin/host-watchdog
echo ${b64(env)} | base64 -d | sudo tee ${HOST_STATE}/watchdog.env >/dev/null && sudo chmod 600 ${HOST_STATE}/watchdog.env
echo ${b64(UNIT)} | base64 -d | sudo tee /etc/systemd/system/host-watchdog.service >/dev/null
echo ${b64(TIMER)} | base64 -d | sudo tee /etc/systemd/system/host-watchdog.timer >/dev/null
# Already active from before the watchdog existed: record since when, from the tunnel container.
if [ "$(sudo docker inspect -f '{{.State.Running}}' cloudflared 2>/dev/null)" = true ] && [ ! -f ${HOST_STATE}/active-since ]; then
  date -d "$(sudo docker inspect -f '{{.State.StartedAt}}' cloudflared)" +%s | sudo tee ${HOST_STATE}/active-since >/dev/null
fi
sudo systemctl daemon-reload && sudo systemctl enable --now host-watchdog.timer >/dev/null 2>&1`);
  log(`  installed; peers: ${peers.join(", ") || "none"}`);
  // The watchdog asks its peers (as root, over Tailscale SSH) whether their tunnel runs.
  for (const p of hosts().filter((x) => x.name !== h.name)) {
    const ok = run(h, `sudo timeout 25 ssh -n -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new ${sshTarget(p)} 'sudo -n docker info >/dev/null && echo ok' 2>&1 | tail -1 || true`, { quiet: true, allowFail: true });
    log(`  root → ${p.name}: ${ok === "ok" ? "ok" : `NOT OK (${ok}); takeover still works if ${p.name} is down, but a returning host can't be told apart`}`);
  }
}

function forHosts(args, fn) {
  const list = args.host ? [host(args.host)] : hosts();
  for (const h of list) {
    if (!runOk(h, "true")) {
      log(`${h.name}: unreachable, skipped`);
      continue;
    }
    fn(h);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), { host: "string", minutes: "string", lines: "string" });
  const cmd = args._[0];
  try {
    if (cmd === "install") forHosts(args, install);
    else if (cmd === "test-mail") forHosts(args, (h) => log(`${h.name}: ${run(h, `sudo ${SERVICES}/bin/host-watchdog --test-mail`)}`));
    else if (cmd === "log") {
      forHosts(args, (h) => {
        step(h.name);
        log(run(h, `systemctl is-active host-watchdog.timer || true; sudo tail -n ${Number(args.lines) || 15} ${HOST_STATE}/watchdog/log 2>/dev/null || echo "(no log: nothing has happened)"`, { quiet: true }));
      });
    } else if (cmd === "pause") {
      const minutes = Number(args.minutes) || 30;
      forHosts(args, (h) => {
        run(h, `echo $(( $(date +%s) + ${minutes * 60} )) | sudo tee ${HOST_STATE}/watchdog.pause-until >/dev/null`);
        log(`${h.name}: watchdog paused for ${minutes} min`);
      });
    } else if (cmd === "resume") {
      forHosts(args, (h) => {
        run(h, `sudo rm -f ${HOST_STATE}/watchdog.pause-until`);
        log(`${h.name}: watchdog resumed`);
      });
    } else {
      console.error("Usage: watchdog.mjs install|log|pause|resume|test-mail [--host <name>] [--minutes N]");
      process.exit(2);
    }
  } catch (err) {
    console.error(`\nwatchdog failed: ${err.message}`);
    process.exit(1);
  }
}

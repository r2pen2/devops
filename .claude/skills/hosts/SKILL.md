---
name: hosts
description: Run, move or add machines that host the joed.dev stack (glados, bouldergeist, or a new one on Windows, Mac or Linux). Use when glados or another host is down or failing, when the user wants to add a host, move the stack, fail over, promote a standby, check where things run, sync a standby, or when two hosts' data has diverged and one copy must overwrite the other.
---

# Hosts: where the joed.dev stack runs

The whole stack (Traefik, the Cloudflare tunnel, the sign-in, every app and database) is Docker compose projects
under `/opt/services` on a **host**. A host is a Linux environment with Docker on the Tailscale network:
glados natively, bouldergeist inside WSL2, a Mac inside OrbStack/Lima. They're listed in `hosts/hosts.json` in
r2pen2/devops (local clone: `D:\Code\devops`), with the projects each must `skip` (hardware it lacks).

- **Active** host: the one running the `cloudflared` container. It gets all public traffic, runs the crons
  (`/etc/cron.d/wl-*`), and its runners hold the `glados` label that every repo's deploy jobs use. This is
  never stored; it's read from the hosts.
- **Standby** hosts: the same projects running, no tunnel, crons parked in `/opt/services/host-state/cron`.
  Their data is a copy, refreshed by `sync`.

Scripts are in `ci/scripts/host/`, run with node from the devops clone, from anywhere that can SSH to the hosts
(`ssh joe@<name>` over Tailscale). Read a script's header before using an option you haven't used.

## Rules

- **Never two tunnels.** If two hosts run `cloudflared`, Cloudflare splits requests between them and the data
  diverges. `promote` is the only thing that should start or stop the tunnel. `status` warns about it.
- **Ask Joe before** `promote --yes`, `data-copy` without `--dry-run`, `data-restore`, or anything with
  `--overwrite-active`. Show him the plan or the dry run first. Read-only commands (`status`, dry runs) need no ask.
- **Never print or copy secrets** into the conversation: `/opt/services/data/app-env/*` moves host to host via
  `sync` only.
- Prefer the scripts over ad-hoc docker commands on a host; they keep the active/standby state consistent.

## Check where things run

```
node ci/scripts/host/status.mjs              # each host: active or standby, containers, crons, load, battery
node ci/scripts/host/status.mjs --runners    # which runner holds the production label, per repo
node ci/scripts/host/status.mjs --data       # every dataset on every host, side by side
```

## The active host is down (sites return Cloudflare 530/1033)

1. `status.mjs`: is the active host unreachable, or reachable with its containers stopped?
2. Reachable but stopped (it rebooted, Docker is slow): wait for Docker, then check again; often nothing else is
   needed. glados' battery shows in status; "Discharging" while plugged in means the charger can't keep up.
3. Unreachable, or not coming back: tell Joe, then promote the standby without a final sync:
   `node ci/scripts/host/promote.mjs <standby>` (plan), then with `--yes --no-sync` once he agrees.
   It serves the data from the last sync; anything written on the dead host since then stays there.
4. When the old host returns, it must not start its tunnel: run `status`. If both run it, stop the one that
   isn't supposed to be active by promoting the right one again (`promote <the right one> --yes`, which skips
   work that's already done). Then compare data (`status --data`) and decide with Joe what to copy.

## Planned move (e.g. glados → bouldergeist)

1. `sync.mjs --from <active> --to <standby> --dry-run`, then without `--dry-run`. First sync takes a while
   (images, ~3 GB of data). It starts every project except the tunnel and the target's `skip` list, then copies
   the Mongo/Postgres databases by dump and restore.
2. Check the standby serves locally: `ssh joe@<standby> "curl -s -o /dev/null -w '%{http_code}' -H 'Host: youcandoitgardening.com' http://127.0.0.1/"` → 200.
3. Make sure the standby has runners (`status --runners`; register below if not).
4. `promote.mjs <standby>` shows the plan; with Joe's OK, `--yes`. Public sites are down for the few minutes
   between stopping the old tunnel and starting the new one (the final sync happens in between).
   On failed health checks it hands everything back automatically.
5. `status.mjs --runners` to confirm.

Moving back later is the same with the names swapped.

## Add a host

1. **Get a Linux shell on it with systemd:**
   - Windows: in an admin PowerShell, from a devops clone or a copy of the script:
     `powershell -ExecutionPolicy Bypass -File host\windows\setup.ps1`. It installs WSL2 Ubuntu, `.wslconfig`
     (no idle shutdown), a start-at-sign-in task, and no sleep on mains. Joe creates the user `joe` on first launch,
     and should turn on automatic sign-in so it survives reboots unattended.
   - Mac: OrbStack (or Lima) with an Ubuntu machine.
   - Linux: nothing extra.
2. **Inside that shell, as the deploy user:**
   `sudo apt-get install -y gh && gh auth login && gh repo clone r2pen2/devops && cd devops && bash ci/scripts/host/bootstrap.sh <name>`
   On WSL the first run enables systemd and asks for `wsl --shutdown`; then run it again. Tailscale prints a
   login URL: Joe approves the machine. That's the only manual step.
3. **Register it:** add an entry to `hosts/hosts.json` (name, os, user, tailscale, `skip` for hardware it lacks,
   `skipRepos` for repos whose deploy jobs need that hardware), and add it to the `from`/`to` choices in
   `.github/workflows/data-copy.yml`. PR in r2pen2/devops.
4. **Runners**, on the new host (needs `RUNNER_ADMIN_PAT` or `gh auth` with admin on the repos):
   `node ci/scripts/runners/register.mjs --from-list ci/runners.json --host <name>`
   They're labelled `host-<name>` only, so they take no production jobs until a promote.
5. **Copy the stack:** the "Planned move" steps 1–3. Now it's a working standby.

Tailscale SSH must allow hosts to reach each other as `joe` (and the scripts run `sudo` there): in the tailnet
ACL, an `ssh` rule with `"action": "accept"` (not `check`) from Joe's devices to Joe's devices.

## Data diverged (writes landed on both hosts)

1. `status.mjs --data` or `data-copy.mjs --from A --to B --dry-run` shows each dataset on both sides: row or
   document counts, file counts, newest change. Show Joe and ask which side wins, per dataset if it's mixed.
2. `data-copy.mjs --from <winner> --to <loser> --only <datasets>`. It snapshots the loser first, copies, checks
   the counts match, and restores the snapshot on failure. Overwriting the active host needs
   `--overwrite-active` and Joe's explicit OK.
   From a phone: GitHub → r2pen2/devops → Actions → "Copy data between hosts" (dry run by default).
3. Undo: `data-restore.mjs --host <loser> --dataset <name> --list`, then without `--list` (newest snapshot)
   or with `--stamp`.

Datasets are in `hosts/datasets.json`. A new app with state needs an entry there (`files` with its
`data/app-assets/<app>` path, or `mongo`/`postgres` with its container), and its raw database directory in
`rawDirs`, so `sync` never copies a live database's files.

## Things that stay with one machine

Home Assistant (host networking, Bluetooth over D-Bus), the speaker and music (PulseAudio, the paired LEXON
MINO), the LAN DNS (coredns bound to glados' LAN IP) and glados-netwatch (its Wi-Fi). They're in bouldergeist's
`skip`/`skipRepos`. While glados is off, they're down.

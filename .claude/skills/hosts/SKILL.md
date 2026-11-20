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
(`ssh <user>@<name>` over Tailscale; a host's `address`, e.g. a LAN IP, is used instead while it isn't on the
tailnet). Run from a host itself, set `HOST_NAME=<its name>` so it runs its own commands locally. Read a script's header before using an option you haven't used.

## Rules

- **Never two tunnels, except inside `promote`.** If two hosts run `cloudflared`, Cloudflare splits requests between
  them and the data diverges. `promote` deliberately overlaps them for about a minute so the sites never go down
  (Joe prefers a few lost writes to downtime); `--clean-cut` stops the old one first instead. Nothing else should
  start or stop the tunnel, besides the watchdog (below). `status` warns when two run.
- **Before restarting a host on purpose** (Windows updates, maintenance): promote the other host first, or
  at least `watchdog.mjs pause --minutes 30`, or the watchdog will fail over mid-restart.
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

## Watchdog (automatic failover)

`host-watchdog.timer` runs `ci/scripts/host/watchdog.sh` every minute on every host (installed by
`node ci/scripts/host/watchdog.mjs install`; re-run it after changing `hosts.json` or the script).
- A **standby** takes over (starts its tunnel and crons) when the sites in `hosts.json` `watchdog.checks` get
  Cloudflare's no-tunnel errors (502/503/530) 3 minutes in a row AND the active host is unreachable or its
  tunnel is down. Its own internet being down (no answer at all) never triggers it.
- When the dead host comes back with its tunnel, both run it; after 5 minutes the one that became active earlier
  (`/opt/services/host-state/active-since`, written by promote and by a takeover) stops its tunnel.
- The **active** host emails when the sites are down although its tunnel runs (failing over wouldn't help).
- Every event emails `watchdog.alertTo` through the host's own site-mail. A takeover does NOT move the deploy
  runner label (needs `gh`): finish with `promote.mjs <new active> --yes`, then compare data (`status --data`).
- `watchdog.mjs log` shows what each host's watchdog did; `pause`/`resume`; `test-mail --host x`.
  `promote` pauses all watchdogs while it runs.

## The active host is down (sites return Cloudflare 530/1033)

0. The watchdog should already have failed over within ~4 minutes and emailed: `watchdog.mjs log`, `status`.
   If it did, finish the move (runner label) and skip to step 4.
1. `status.mjs`: is the active host unreachable, or reachable with its containers stopped?
2. Reachable but stopped (it rebooted, Docker is slow): wait for Docker, then check again; often nothing else is
   needed. glados' battery shows in status; "Discharging" while plugged in means the charger can't keep up.
3. Unreachable, or not coming back: tell Joe, then promote the standby without a final sync:
   `node ci/scripts/host/promote.mjs <standby>` (plan), then with `--yes --no-sync` once he agrees.
   It serves the data from the last sync; anything written on the dead host since then stays there.
4. When the old host returns, its watchdog hands over within ~5 minutes; check with `status`. If both still run
   the tunnel, promote the right one again (`promote <the right one> --yes`, which skips work that's already
   done). Then compare data (`status --data`) and decide with Joe what to copy.

## Planned move (e.g. glados → bouldergeist)

1. `sync.mjs --from <active> --to <standby> --dry-run`, then without `--dry-run`. First sync takes a while
   (images, ~1 GB of data). It starts every project except the tunnel and the target's `skip` list, copies
   the Mongo/Postgres databases by dump and restore, and registers the standby's CI runners (runners.mjs; needs
   `gh` signed in where it runs, which mints the tokens, so the host never holds one).
2. Check the standby serves locally: `ssh joe@<standby> "curl -s -o /dev/null -w '%{http_code}' -H 'Host: youcandoitgardening.com' http://127.0.0.1/"` → 200.
3. Make sure the standby has runners: `status --runners`, or `runners.mjs --host <standby>` if sync couldn't.
4. `promote.mjs <standby>` shows the plan; with Joe's OK, `--yes`. No downtime: it syncs while the old host
   serves, starts the new tunnel, checks the new host, and only then stops the old tunnel. If the new host isn't
   healthy it backs out and the old host never stopped.
5. `status.mjs --runners` to confirm.

Moving back later is the same with the names swapped.

## Add a host

1. **Get a Linux shell on it with systemd:**
   - Windows: in an admin PowerShell, from a devops clone or a copy of the script:
     `powershell -ExecutionPolicy Bypass -File host\windows\setup.ps1`. It installs WSL2 Ubuntu, `.wslconfig`
     (no idle shutdown), a task that starts WSL at boot with nobody signed in (asks for the Windows password once),
     no automatic Windows Update restarts, and no sleep on mains. Joe creates the Linux user on first launch.
     Before restarting a Windows host (updates), promote the other host first.
   - Mac: OrbStack (or Lima) with an Ubuntu machine.
   - Linux: nothing extra.
2. **Inside that shell, as the deploy user:**
   `sudo apt-get install -y gh && gh auth login && gh repo clone r2pen2/devops && cd devops && bash ci/scripts/host/bootstrap.sh <name>`
   On WSL the first run enables systemd and asks for `wsl --shutdown`; then run it again. Tailscale prints a
   login URL: Joe approves the machine. That's the only manual step.
3. **Register it:** add an entry to `hosts/hosts.json` (name, os, user, tailscale, `skip` for hardware it lacks,
   `skipRepos` for repos whose deploy jobs need that hardware), and add it to the `from`/`to` choices in
   `.github/workflows/data-copy.yml`. PR in r2pen2/devops.
4. **Copy the stack:** the "Planned move" steps 1–3, from a machine where `gh` is signed in. Sync also registers
   the host's CI runners (`<name>-<repo>`, label `host-<name>` only, so no production jobs until a promote).
   Now it's a working standby.

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

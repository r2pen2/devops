# Hosts

The stack can run on more than one machine. One host is **active** (it runs the Cloudflare tunnel, so it gets all
public traffic, plus the crons and the production CI jobs); the others are **standbys** that run the same compose
projects with a copy of the data, ready to take over with one command.

| Host | What it is | Notes |
|---|---|---|
| glados | 2014 MacBook Pro, Ubuntu | Owns the Bluetooth speaker, Home Assistant and the LAN DNS |
| bouldergeist | Windows 11 PC, stack in WSL2 Ubuntu | Skips those hardware-bound projects |

The list is `hosts/hosts.json`; the stateful data is `hosts/datasets.json`. Hosts reach each other over
[Tailscale](https://tailscale.com) SSH, so they can be on any network and any OS (Windows via WSL2, Mac via an
OrbStack or Lima Ubuntu VM).

## Commands

From a clone of this repo, on any machine that can SSH to the hosts:

| Command | Does |
|---|---|
| `node ci/scripts/host/status.mjs [--runners] [--data]` | Which host is active, what runs where, battery, data side by side |
| `node ci/scripts/host/sync.mjs --from A --to B [--dry-run]` | Mirror A's stack and data onto standby B, and register B's CI runners |
| `node ci/scripts/host/runners.mjs --host B [--dry-run]` | Register B's CI runners (sync does this; tokens minted by `gh` on the controller) |
| `node ci/scripts/host/promote.mjs B [--yes] [--no-sync]` | Make B active: tunnel, crons and the `glados` runner label move to it |
| `node ci/scripts/host/data-copy.mjs --from A --to B [--only x,y] [--dry-run]` | Overwrite B's datasets with A's (snapshot first) |
| `node ci/scripts/host/data-restore.mjs --host B --dataset x [--list \| --stamp S]` | Put a snapshot back |
| `node ci/scripts/host/tag-runners.mjs [--dry-run]` | Label each runner `host-<name>` |
| `bash ci/scripts/host/bootstrap.sh <name>` | Set up a new host (run on it) |
| `host/windows/setup.ps1` | Windows only, before bootstrap: WSL2, no sleep, start at sign-in |

Data can also be copied from GitHub: Actions → **Copy data between hosts** (a dry run by default).

## How it fits together

- **Traffic:** the tunnel is token-based, so whichever host runs `cloudflared` with that token gets the traffic.
  DNS never changes. Two connectors at once would split requests between hosts, so only `promote` starts it.
- **CI:** every repo's deploy jobs use `runs-on: [self-hosted, glados]`. `glados` is now the production label:
  promote moves it to the new host's runners through the GitHub API, so no workflow changes. `sync` registers a new
  host's runners (`runners.mjs`): the controller mints each registration token with `gh` and configures the runner
  over SSH, labelled `host-<name>` only.
- **Data:** `sync` mirrors `/opt/services` with rsync, except QA previews, backups, telemetry and raw database
  directories, and copies Mongo and Postgres with dump and restore. `data-copy` does one dataset at a time in
  either direction, with a snapshot first.
- **Safety:** `sync`, `data-copy` and `data-restore` refuse to write over the active host unless told
  `--overwrite-active`. `promote` stops the old tunnel before the final sync (so no writes are lost), checks
  the new host's health, and hands traffic back if the checks fail.

Adding a host, failing over and fixing diverged data step by step: `.claude/skills/hosts/SKILL.md`.

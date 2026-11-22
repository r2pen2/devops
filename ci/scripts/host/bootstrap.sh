#!/usr/bin/env bash
# Turn a fresh Ubuntu/Debian environment into a host that can run the joed.dev stack. Safe to re-run.
#
#   bash ci/scripts/host/bootstrap.sh <name>        # from a clone of r2pen2/devops (private), e.g.:
#     sudo apt-get install -y gh && gh auth login && gh repo clone r2pen2/devops && cd devops
#   ssh <user>@<lan-ip> 'bash -s -- <name>' < ci/scripts/host/bootstrap.sh    # or push it from another machine
#
# <name> is the host's name in hosts/hosts.json (and on the tailnet). Works on native Linux, inside WSL2 (Windows,
# see host/windows/setup.ps1) and inside an OrbStack/Lima Ubuntu VM (Mac). Installs Docker Engine + Compose,
# Node 20, gh, rsync and Tailscale; joins the tailnet with Tailscale SSH on; creates /opt/services and the shared
# `proxy` network; lets the current user sudo without a password (the deploy scripts need it).
#
# The one interactive step: Tailscale prints a login URL the first time. Open it and approve the machine.
set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "Usage: bootstrap.sh <host-name>   (as in hosts/hosts.json)" >&2
  exit 2
fi
ME="$(id -un)"
say() { printf '\n== %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the deploy user (e.g. joe), not root; it uses sudo where needed." >&2
  exit 1
fi

say "passwordless sudo for $ME"
if ! sudo -n true 2>/dev/null; then
  echo "Enter your password once so this script can set that up:"
fi
echo "$ME ALL=(ALL) NOPASSWD:ALL" | sudo tee "/etc/sudoers.d/90-$ME-deploy" >/dev/null
sudo chmod 440 "/etc/sudoers.d/90-$ME-deploy"

# WSL2: the stack needs systemd (docker, tailscaled and the runners are services).
if grep -qi microsoft /proc/version 2>/dev/null; then
  say "WSL2 detected"
  if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
    printf '[boot]\nsystemd=true\n\n[network]\nhostname=%s\n' "$NAME" | sudo tee /etc/wsl.conf >/dev/null
    echo "Enabled systemd in /etc/wsl.conf. In PowerShell run:  wsl --shutdown"
    echo "then open the distro again and re-run this script."
    exit 0
  fi
  if [ "$(ps -p 1 -o comm=)" != systemd ]; then
    echo "systemd is configured but not running yet. In PowerShell run:  wsl --shutdown   then re-run this." >&2
    exit 1
  fi
  # Audio (the speaker / radio): WSLg's PulseAudio plays out of the PC. Containers mount the deploy user's
  # /run/user/<uid>/pulse, where WSLg only leaves symlinks into /mnt/wslg; bind the real socket folder there
  # (before Docker starts its containers), and keep /run/user/<uid> for good (linger) so it isn't torn down.
  say "WSLg audio for containers"
  sudo loginctl enable-linger "$ME"
  uid=$(id -u "$ME")
  sudo tee /etc/systemd/system/wslg-pulse.service >/dev/null <<UNIT
[Unit]
Description=WSLg PulseAudio socket at /run/user/$uid/pulse for containers (r2pen2/devops bootstrap.sh)
After=user-runtime-dir@$uid.service
Wants=user-runtime-dir@$uid.service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for i in \$(seq 1 60); do [ -S /mnt/wslg/runtime-dir/pulse/native ] && break; sleep 1; done; mkdir -p /run/user/$uid/pulse; mountpoint -q /run/user/$uid/pulse || mount --bind /mnt/wslg/runtime-dir/pulse /run/user/$uid/pulse'
ExecStop=/bin/umount -l /run/user/$uid/pulse

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now wslg-pulse.service >/dev/null
  [ -S "/run/user/$uid/pulse/native" ] && echo "audio: /run/user/$uid/pulse/native → WSLg" || echo "audio: WSLg's PulseAudio socket isn't there (is WSLg on?)" >&2
fi

say "base packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg rsync jq git cron >/dev/null

say "Docker Engine + Compose"
if ! command -v docker >/dev/null || ! sudo docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
fi
sudo systemctl enable --now docker >/dev/null
sudo usermod -aG docker "$ME"
sudo docker --version

say "Node 20"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
node --version

say "GitHub CLI"
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh >/dev/null
fi
gh --version | head -1

say "Tailscale (host network)"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sudo sh >/dev/null
fi
sudo systemctl enable --now tailscaled >/dev/null
if ! sudo tailscale status >/dev/null 2>&1; then
  echo "Open the URL Tailscale prints and approve this machine:"
fi
sudo tailscale up --ssh --hostname "$NAME" --accept-dns=true
sudo tailscale status | head -5

say "/opt/services and the shared network"
sudo mkdir -p /opt/services/{infra,apps,bin,data/app-env,data/app-assets,data/backups,host-state/cron}
sudo chmod 700 /opt/services/data/app-env
sudo docker network inspect proxy >/dev/null 2>&1 || sudo docker network create proxy >/dev/null
sudo systemctl enable --now cron >/dev/null 2>&1 || true

say "done: $NAME is ready"
cat <<EOF
Next, from a machine with the devops repo:
  1. Add "$NAME" to hosts/hosts.json (if it isn't there) and commit.
  2. Copy the stack onto it, which also registers its CI runners (run where gh is signed in):
       node ci/scripts/host/sync.mjs --from <active host> --to $NAME
  3. When you want it live:    node ci/scripts/host/promote.mjs $NAME --yes
Log out and back in once so plain \`docker\` works without sudo.
EOF

# devops

The platform team's repo: everything that keeps **glados** running and ships every other repo's code to it.
Apps live in their own repos; this repo runs them.

```
ci/                 shared build/deploy for every app repo (was r2pen2/deploy-infra-actions)
  actions/            composite actions: build-push, deploy-prod, detect-changed, qa-deploy, qa-cleanup, tooling
  scripts/            what the actions run, plus deploy-stacks.mjs (shared: reusable-stacks.yml)
  runners.json        which repos get a glados runner
stacks.json         the platform stacks below → glados
host/glados/        cloudflared (tunnel + autoheal), coredns (LAN DNS overrides), netwatch (network watchdog)
ingress/            traefik (the sign-in it routes through, oauth2-proxy + sso@file, is r2pen2/it)
updates/            watchtower
```

Push to main → **Deploy stacks** installs whatever changed (backup first, health + SSO check after, restore on
failure). Only files in this repo are written: `traefik/dynamic/billing-blocks.yml` belongs to WL-Universe's
site-billing, which rewrites it at runtime, and `sso.yml` belongs to r2pen2/it. Run it from Actions with *dry run* to see the diff against glados.

Observability (OpenTelemetry Collector, Grafana, Honeycomb, Dozzle, Umami) is r2pen2/observability, deployed
with the same deployer through `reusable-stacks.yml`. Apps, upstream images included, have their own repos (e.g. r2pen2/bindarr) and deploy through `ci/`.

**Secrets are never committed.** They live on glados under `/opt/services/data/app-env/` and reach containers through
`envFile` in stacks.json (`docker compose --env-file`) or a compose `env_file:`.

This repo is private. Its reusable workflows and actions are shared with r2pen2's other private repos
(Settings → Actions → Access: "Accessible from repositories owned by r2pen2").

## CI for an app repo

Put a `deploy/apps.json` catalog next to the app's Dockerfiles and compose files, then:

```yaml
# .github/workflows/publish.yml
name: Publish
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      apps:
        default: all

jobs:
  publish:
    uses: r2pen2/devops/.github/workflows/reusable-publish.yml@main
    with:
      catalog: deploy/apps.json
      apps: ${{ inputs.apps || '' }}
    secrets: inherit
```

QA previews per PR: `reusable-qa-preview.yml` on `pull_request` (opened, synchronize, reopened) and
`reusable-qa-cleanup.yml` on `pull_request` (closed). URLs: `https://pr-<n>-<app>.joed.dev`.

### Catalog (`deploy/apps.json`)

```json
{
  "imagePrefix": "nutrifit",
  "qaHostDomain": "joed.dev",
  "apps": [
    {
      "app": "web",
      "port": 80,
      "kind": "static",
      "dockerfile": "deploy/docker/Dockerfile",
      "compose": "deploy/compose/web.yml",
      "serviceDir": "nutrifit",
      "image": true,
      "host": "nutrifit.joed.dev",
      "watchPaths": ["web/", "deploy/docker/", "deploy/compose/web.yml"],
      "imageTagEnv": "NUTRIFIT_IMAGE_TAG"
    }
  ]
}
```

`"image": false` deploys a compose file for an upstream image without building anything (see r2pen2/bindarr).
Images publish as `ghcr.io/<owner>/<imagePrefix>-<app>:{latest,sha}` (or `:pr-<n>` for QA).

### Actions

| Action | Purpose |
|--------|---------|
| `ci/actions/detect-changed` | Diff → apps_csv |
| `ci/actions/build-push` | docker buildx / docker build → GHCR |
| `ci/actions/deploy-prod` | glados: copy compose to `/opt/services/apps/<serviceDir>/` + `up -d` |
| `ci/actions/qa-deploy` | glados: ephemeral Traefik Host stacks |
| `ci/actions/qa-cleanup` | glados: tear down PR stacks |
| `ci/actions/tooling` | Puts `ci/scripts` in the workspace (callers can't clone this private repo) |

## Runners

Self-hosted runner labels: `self-hosted`, `glados`, registered per repo. The list is
[`ci/runners.json`](ci/runners.json); a PR adding a repo there registers it on glados (and comments the result), and
**Actions → Register glados runners** syncs `all` or a list.

Secret `RUNNER_ADMIN_PAT` must be able to mint runner registration tokens for every listed repo, including this one.

Bootstrap (once, on glados):

```bash
export RUNNER_ADMIN_PAT=ghp_...
node ci/scripts/runners/register.mjs --from-list ci/runners.json --only r2pen2/devops
sudo ~/actions-runner-devops/svc.sh install && sudo ~/actions-runner-devops/svc.sh start
```

## glados-netwatch

`host/glados/netwatch`: a systemd service that checks the router, the internet and DNS every 30 s and
escalates while they stay down (reconfigure Wi-Fi → restart networkd → reload the driver → reboot after 20 min,
at most every 6 h). Reports to the OpenTelemetry Collector (r2pen2/observability) as `glados_network_*` and
`glados_netwatch_*` metrics and a log per action; also `journalctl -t glados-netwatch`.

## On glados

- `/opt/services/apps/<serviceDir>/compose.yml`: app stacks (written by `deploy-prod`)
- `/opt/services/infra/<stack>/`: platform stacks, written by **Deploy stacks**; backups in `/opt/services/infra/backups/`
- `/opt/services/data/app-env/`: secrets, `/opt/services/data/app-assets/`: app data
- **Actions → Inventory glados**: what's running and its config, secrets redacted, as a 1-day artifact

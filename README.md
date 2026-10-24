# devops

The platform team's repo: everything that keeps **glados** running and ships every other repo's code to it.
Apps live in their own repos; this repo runs them.

```
ci/               shared build/deploy for every app repo (was r2pen2/deploy-infra-actions)
  actions/          composite actions: build-push, deploy-prod, detect-changed, qa-deploy, qa-cleanup, tooling
  scripts/          what the actions run
  runners.json      which repos get a glados runner
host/glados/      the machine: cloudflared, docker networks, cron              (being pulled in from glados)
ingress/          traefik (incl. the sso@file middleware), oauth2-proxy        (being pulled in from glados)
updates/          watchtower                                                   (being pulled in from glados)
observability/    grafana, status, liveness; tracing/metrics backends go here  (being pulled in from glados)
dns/              joed.dev zone + Cloudflare tunnel routes
apps/             upstream images nobody here writes (beaverhabits, umami, …)
```

**Secrets are never committed.** They live on glados under `/opt/services/data/app-env/` (written by the workflow that
needs them, from this repo's Actions secrets), and compose files reference them with `env_file:` or `${VAR}`.

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

## On glados

- `/opt/services/apps/<serviceDir>/compose.yml`: app stacks (written by `deploy-prod`)
- `/opt/services/infra/`: platform stacks (being moved under this repo's control)
- `/opt/services/data/app-env/`: secrets, `/opt/services/data/app-assets/`: app data
- **Actions → Inventory glados**: what's running and its config, secrets redacted, as a 1-day artifact

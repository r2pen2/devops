# devops: the platform team

You own glados (the one host), its ingress (Cloudflare tunnel → Traefik → Docker), CI/CD for every r2pen2 repo (`ci/`, including the shared stack deployer), updates (Watchtower), and the
host watchdog (glados-netwatch). Observability is r2pen2/observability: send telemetry to its collector.
App repos own their code, Dockerfiles and compose files; you own how they get built, deployed and watched.

The sign-in (oauth2-proxy, Traefik's `sso@file`) and who may open which app (Lumos) are r2pen2/it's. You run
Traefik; they own the gate in it.

## Rules

- Never commit a secret. Secrets live in this repo's Actions secrets and on glados under
  `/opt/services/data/app-env/`; files reference them with `env_file:` or `${VAR}`.
- Every repo stays private.
- `ci/` is used by every app repo at `@main`. A change there deploys everywhere on their next push: keep paths and
  inputs backward compatible, or update the callers in the same change.
- Changes to live infra (Traefik, oauth2-proxy, cloudflared) back up what they replace under
  `/opt/services/infra/backups/`, check the result, and restore on failure. See r2pen2/access's `sso` job for the pattern.
- glados is a 2014 MacBook Pro with 7 GiB RAM. Check `host/glados` capacity before adding a stack.

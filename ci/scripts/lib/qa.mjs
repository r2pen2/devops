/**
 * Shared pieces of the QA preview scripts: catalog {placeholders} and the per-PR data seed runner.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { resolveImageName } from "./catalog.mjs";
import { cmsCollectionPrefix, qaContainerName, qaHostname } from "./naming.mjs";

export const QA_ASSETS_ROOT = "/opt/services/data/app-assets/qa";

/** Values for {placeholders} in an app's qaVolumes / qaEnvironment / qaPreDeploy / qaCopyFiles. */
export function qaContext(catalog, pr, app) {
  const entry = catalog.byName[app];
  return {
    pr: String(pr),
    app,
    port: String(entry.port),
    container: qaContainerName(pr, app),
    pkg: entry.packagePath || `packages/${app}`,
    assets: path.posix.join(QA_ASSETS_ROOT, `pr-${pr}`, app),
    prodAssets: `/opt/services/data/app-assets/${app}`,
    cmsPrefix: cmsCollectionPrefix(pr),
    domain: catalog.qaHostDomain,
  };
}

/** Replace {name} and {host:<app>} / {url:<app>} in s. Unknown names are an error, not left in. */
export function expand(s, ctx) {
  return String(s).replace(/\{([a-zA-Z]+)(?::([a-z0-9-]+))?\}/g, (m, key, arg) => {
    if (key === "host" && arg) return qaHostname(ctx.pr, arg, ctx.domain);
    if (key === "url" && arg) return `https://${qaHostname(ctx.pr, arg, ctx.domain)}`;
    if (arg === undefined && Object.hasOwn(ctx, key)) return ctx[key];
    throw new Error(`Unknown placeholder ${m} in "${s}"`);
  });
}

function imageExists(image) {
  try {
    execFileSync("sudo", ["docker", "image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pull(image) {
  try {
    execFileSync("sudo", ["docker", "pull", image], { stdio: "inherit" });
    return true;
  } catch {
    return imageExists(image);
  }
}

/**
 * The tag to run app with in PR pr: :pr-N if that image exists, else the catalog's qaTagFallback
 * (e.g. latest, for companions the PR didn't change). Pulls the image it picks.
 */
export function resolveQaTag(catalog, owner, pr, app) {
  const base = resolveImageName(catalog, owner, app);
  if (pull(`${base}:pr-${pr}`)) return `pr-${pr}`;
  const fallback = catalog.qaTagFallback;
  if (fallback && pull(`${base}:${fallback}`)) {
    console.warn(`${base}:pr-${pr} not found (${app} unchanged in this PR); using :${fallback}`);
    return fallback;
  }
  throw new Error(`No image for ${app}: ${base}:pr-${pr}${fallback ? ` or :${fallback}` : ""}`);
}

/**
 * The seed config: the catalog's qaSeed, or the legacy --firestore-script (run in the app's own
 * image with the script's folder mounted at /repo/scripts).
 */
export function seedConfig(catalog, legacyScript) {
  if (catalog.qaSeed?.script) return { ...catalog.qaSeed, legacy: false };
  if (legacyScript) return { script: legacyScript, legacy: true };
  return null;
}

/** Apps whose per-PR data gets seeded and cleaned up. */
export function seedApps(catalog) {
  return catalog.qaApps.filter((a) => a.cms).map((a) => a.app);
}

/**
 * Run the seed script (node <script> ...args) in a container. pr picks the image tag (:pr-N, then
 * the fallback); pr null uses the fallback (or latest) only, for sweeps.
 */
export function runSeed({ catalog, owner, cwd, seed, app, pr, args }) {
  const runner = seed.image || app;
  const base = resolveImageName(catalog, owner, runner);
  const tags = [];
  if (pr) tags.push(`pr-${pr}`);
  tags.push(catalog.qaTagFallback || "latest");
  const image = tags.map((t) => `${base}:${t}`).find((i) => pull(i));
  if (!image) throw new Error(`No image to run ${seed.script}: tried ${tags.map((t) => `${base}:${t}`).join(", ")}`);

  const docker = ["docker", "run", "--rm", "-v", "/opt/services/data/app-env:/opt/services/data/app-env:ro"];
  let scriptInContainer;
  if (seed.legacy) {
    const scriptPath = path.resolve(cwd, seed.script);
    docker.push("-v", `${path.dirname(scriptPath)}:/repo/scripts:ro`);
    scriptInContainer = `/repo/scripts/${path.basename(scriptPath)}`;
  } else {
    const mounts = seed.mounts?.length ? seed.mounts : [path.posix.dirname(seed.script)];
    for (const dir of mounts) {
      docker.push("-v", `${path.resolve(cwd, dir)}:${path.posix.join("/repo", dir)}:ro`);
    }
    if (seed.nodePath) docker.push("-e", `NODE_PATH=${seed.nodePath}`);
    scriptInContainer = path.posix.join("/repo", seed.script);
  }
  docker.push("--entrypoint", "node", image, scriptInContainer, ...args);
  console.log(`+ sudo ${docker.join(" ")}`);
  execFileSync("sudo", docker, { stdio: "inherit" });
}

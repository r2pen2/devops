/**
 * Load a deploy catalog JSON from a consumer repo.
 *
 * Schema:
 * {
 *   "imagePrefix": "nutrifit",          // ghcr.io/<owner>/<prefix>-<app>
 *   "qaHostDomain": "joed.dev",         // optional
 *   "apps": [
 *     {
 *       "app": "web",
 *       "port": 80,
 *       "kind": "static",               // static | spa | express | api | infra
 *       "dockerfile": "deploy/docker/Dockerfile",
 *       "context": "app",               // optional build context (default: repo root)
 *       "compose": "deploy/compose/web.yml",
 *       "serviceDir": "nutrifit",       // /opt/services/apps/<serviceDir>
 *       "image": true,                  // false = compose-only (mongo, etc.)
 *       "imageName": "nutrifit",        // optional override of prefix-app
 *       "host": "nutrifit.joed.dev",    // optional (docs)
 *       "packagePath": "packages/web",  // optional WL-style APP_DIR
 *       "cms": false,
 *       "extraVolumes": [],
 *       "watchPaths": ["web/", "deploy/"],
 *       "buildArgs": { "PORT": "80" },  // optional docker build-args
 *       "qa": true,                     // include in QA previews (default true if image)
 *
 *       // Optional QA preview extras. Strings may use {placeholders}: {pr} {app} {port}
 *       // {container} {pkg} {assets} (this preview's asset dir) {prodAssets} {cmsPrefix}
 *       // {host:<app>} / {url:<app>} (another app's preview host / https URL).
 *       "companions": ["api"],          // deployed first with this app, even if the PR didn't change them
 *       "qaVolumes": ["{prodAssets}/x:/x:ro"],
 *       "qaEnvironment": { "API_URL": "{url:api}" },
 *       "qaPreDeploy": ["sudo bash scripts/x.sh"],   // run in the repo checkout before deploying
 *       "qaCloneAssets": "/opt/services/data/app-assets/x",  // copied into {assets} (cp -a -n)
 *       "qaCopyFiles": [{ "from": "/a", "to": "/b" }]        // sudo cp -p, only if "to" is missing
 *     }
 *   ],
 *
 *   // Optional, top level:
 *   "sharedPaths": ["package-lock.json"],   // changes here select every app (default: see detect-changed-apps)
 *   "qaTagFallback": "latest",              // use this tag when an app has no :pr-N image (e.g. companions)
 *   "qaSeed": {                             // seed/cleanup/sweep per-PR data for "cms": true apps
 *     "script": "scripts/qa/firestore-qa.mjs",  // run with node inside an image, args: seed|cleanup|sweep
 *     "image": "cms",                       // app whose image runs it (default: the app itself)
 *     "nodePath": "/repo/packages/cms/node_modules",
 *     "mounts": ["scripts", "deploy"]       // repo dirs mounted read-only at /repo/<dir>
 *   }
 * }
 *
 * watchPaths entries: "dir/" (prefix), "file" (exact or dir), "re:<regex>", and "!..." to exclude.
 */
import fs from "node:fs";
import path from "node:path";

export function loadCatalog(catalogPath, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, catalogPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Catalog not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!raw.imagePrefix || typeof raw.imagePrefix !== "string") {
    throw new Error("catalog.imagePrefix is required");
  }
  if (!Array.isArray(raw.apps) || raw.apps.length === 0) {
    throw new Error("catalog.apps must be a non-empty array");
  }

  const qaHostDomain = raw.qaHostDomain || "joed.dev";
  const apps = raw.apps.map((a) => normalizeApp(a, raw.imagePrefix));
  const byName = Object.fromEntries(apps.map((a) => [a.app, a]));

  return {
    imagePrefix: raw.imagePrefix,
    qaHostDomain,
    sharedPaths: Array.isArray(raw.sharedPaths) ? raw.sharedPaths : null,
    qaTagFallback: raw.qaTagFallback || null,
    qaSeed: raw.qaSeed || null,
    apps,
    byName,
    publishApps: apps,
    qaApps: apps.filter((a) => a.qa !== false && a.image !== false),
    buildApps: apps.filter((a) => a.image !== false),
  };
}

function normalizeApp(a, imagePrefix) {
  if (!a.app) throw new Error("each catalog app requires app");
  const image = a.image !== false;
  return {
    app: a.app,
    port: a.port ?? 80,
    kind: a.kind || (image ? "static" : "infra"),
    dockerfile: a.dockerfile || null,
    context: a.context || ".",
    compose: a.compose || `deploy/compose/${a.app}.yml`,
    serviceDir: a.serviceDir || a.app,
    image,
    imageName: a.imageName || null,
    host: a.host || null,
    packagePath: a.packagePath || null,
    cms: Boolean(a.cms),
    extraVolumes: a.extraVolumes || [],
    watchPaths: a.watchPaths || defaultWatchPaths(a),
    buildArgs: a.buildArgs || {},
    qa: a.qa !== false && image,
    imageTagEnv: a.imageTagEnv || null,
    networks: a.networks || ["proxy"],
    companions: a.companions || [],
    qaVolumes: a.qaVolumes || [],
    qaEnvironment: a.qaEnvironment || {},
    qaPreDeploy: a.qaPreDeploy || [],
    qaCloneAssets: a.qaCloneAssets || null,
    qaCopyFiles: a.qaCopyFiles || [],
  };
}

function defaultWatchPaths(a) {
  const paths = [];
  if (a.compose) paths.push(a.compose);
  if (a.dockerfile) paths.push(a.dockerfile);
  if (a.packagePath) {
    paths.push(a.packagePath.endsWith("/") ? a.packagePath : `${a.packagePath}/`);
  }
  return paths;
}

export function resolveImageName(catalog, owner, appName) {
  const entry = catalog.byName[appName];
  if (!entry) throw new Error(`Unknown app: ${appName}`);
  const ownerLc = String(owner).toLowerCase();
  if (entry.imageName) {
    return `ghcr.io/${ownerLc}/${entry.imageName}`;
  }
  return `ghcr.io/${ownerLc}/${catalog.imagePrefix}-${entry.app}`;
}

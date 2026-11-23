#!/usr/bin/env node
/**
 * Detect which catalog apps changed between two git refs.
 *
 *   node scripts/detect-changed-apps.mjs --catalog deploy/apps.json --base SHA --head SHA [--scope qa|publish] [--json]
 *
 * Rules (generic):
 *   - Any path matching an app's watchPaths → that app
 *   - Shared triggers (optional --shared-prefix, default deploy/docker/, scripts/, package.json)
 *     → all buildable apps in scope (or all publish apps)
 *   - App-specific compose / dockerfile always counted via watchPaths
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./lib/catalog.mjs";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    base: null,
    head: "HEAD",
    json: false,
    scope: "publish",
    shared: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--base" && argv[i + 1]) args.base = argv[++i];
    else if (a === "--head" && argv[i + 1]) args.head = argv[++i];
    else if (a === "--scope" && argv[i + 1]) args.scope = argv[++i];
    else if (a === "--shared" && argv[i + 1]) {
      args.shared = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--json") args.json = true;
  }
  if (!args.base) throw new Error("--base <ref> is required");
  if (args.scope !== "qa" && args.scope !== "publish") {
    throw new Error('--scope must be "qa" or "publish"');
  }
  return args;
}

/** Paths whose change selects every app, unless --shared or the catalog's sharedPaths says otherwise. */
const DEFAULT_SHARED = [
  "deploy/docker/",
  "scripts/",
  "package.json",
  "package-lock.json",
  ".github/workflows/",
];

function changedFiles(base, head) {
  const out = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pathHit(file, watch) {
  if (!watch) return false;
  if (watch.startsWith("re:")) return new RegExp(watch.slice(3)).test(file);
  if (watch.endsWith("/")) return file.startsWith(watch) || file === watch.slice(0, -1);
  return file === watch || file.startsWith(`${watch}/`);
}

/** True if file matches one of watches and none of its "!" exclusions. */
export function watched(file, watches) {
  const include = watches.filter((w) => !w.startsWith("!"));
  const exclude = watches.filter((w) => w.startsWith("!")).map((w) => w.slice(1));
  return include.some((w) => pathHit(file, w)) && !exclude.some((w) => pathHit(file, w));
}

export function detect(files, catalog, scope, sharedPrefixes) {
  const pool = scope === "qa" ? catalog.qaApps : catalog.publishApps;
  const selected = new Set();

  const sharedHit = files.some((f) =>
    sharedPrefixes.some((p) => pathHit(f, p) || (!p.startsWith("re:") && f.startsWith(p))),
  );

  for (const entry of pool) {
    const own = files.some((f) => watched(f, entry.watchPaths || []));
    if (!sharedHit && !own) continue;
    // Infra-only apps (image:false) only when their own paths change, not shared docker noise
    if (entry.image === false && !own) continue;
    selected.add(entry.app);
  }

  // If shared hit selected nothing useful, fall back to all image apps
  if (sharedHit && selected.size === 0) {
    for (const a of catalog.buildApps) {
      if (scope === "qa" && a.qa === false) continue;
      selected.add(a.app);
    }
  }

  return pool.map((a) => a.app).filter((name) => selected.has(name));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog);
  const files = changedFiles(args.base, args.head);
  const shared = args.shared.length ? args.shared : catalog.sharedPaths ?? DEFAULT_SHARED;
  const apps = detect(files, catalog, args.scope, shared);
  const payload = {
    apps,
    files,
    base: args.base,
    head: args.head,
    scope: args.scope,
  };
  if (args.json) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(apps.join("\n"));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

#!/usr/bin/env node
/**
 * Tear down ephemeral QA projects for a PR and update active.json.
 *
 *   node scripts/qa/cleanup-pr.mjs --catalog deploy/apps.json --pr 42 [--prune-images]
 *   node scripts/qa/cleanup-pr.mjs ... [--pr 42] --sweep --open 92,94   # also: delete every non-open PR's leftovers
 *
 * Per-PR data of cms apps is removed with the catalog's qaSeed script ("cleanup", "sweep").
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, resolveImageName } from "../lib/catalog.mjs";
import { qaProjectName } from "../lib/naming.mjs";
import { runSeed, seedApps, seedConfig } from "../lib/qa.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infraRoot = path.resolve(__dirname, "../..");
const QA_COMPOSE_ROOT = "/opt/services/data/app-assets/qa/compose";
const QA_ASSETS_ROOT = "/opt/services/data/app-assets/qa";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    pr: null,
    pruneImages: false,
    owner: "r2pen2",
    cwd: process.cwd(),
    firestoreScript: null,
    sweep: false,
    open: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--pr" && argv[i + 1]) args.pr = String(argv[++i]);
    else if (a === "--prune-images") args.pruneImages = true;
    else if (a === "--owner" && argv[i + 1]) args.owner = argv[++i];
    else if (a === "--cwd" && argv[i + 1]) args.cwd = argv[++i];
    else if (a === "--firestore-script" && argv[i + 1]) {
      args.firestoreScript = argv[++i];
    } else if (a === "--sweep") args.sweep = true;
    else if (a === "--open" && argv[i + 1] !== undefined) {
      args.open = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (!args.pr && !args.sweep) throw new Error("--pr (or --sweep --open N,M) is required");
  if (args.sweep && !args.open) throw new Error("--sweep needs --open (open PR numbers; may be empty)");
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  try {
    return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
  } catch (err) {
    if (opts.allowFail) {
      console.warn(`command failed (ignored): ${cmd} ${cmdArgs.join(" ")}`);
      return null;
    }
    throw err;
  }
}

function sh(script, allowFail = false) {
  run("bash", ["-lc", script], { allowFail });
}

function cleanupOne(pr, app) {
  const project = qaProjectName(pr, app);
  const composeFile = path.join(QA_COMPOSE_ROOT, `pr-${pr}`, app, "compose.yml");

  if (fs.existsSync(composeFile)) {
    run(
      "sudo",
      [
        "docker",
        "compose",
        "-p",
        project,
        "-f",
        composeFile,
        "down",
        "--remove-orphans",
      ],
      { allowFail: true },
    );
  } else {
    run(
      "sudo",
      ["docker", "compose", "-p", project, "down", "--remove-orphans"],
      { allowFail: true },
    );
  }

  sh(`sudo rm -rf ${JSON.stringify(path.join(QA_COMPOSE_ROOT, `pr-${pr}`, app))}`, true);
  sh(`sudo rm -rf ${JSON.stringify(path.join(QA_ASSETS_ROOT, `pr-${pr}`, app))}`, true);
}

function pruneImages(catalog, pr, owner) {
  for (const entry of catalog.qaApps) {
    const image = `${resolveImageName(catalog, owner, entry.app)}:pr-${pr}`;
    run("sudo", ["docker", "image", "rm", "-f", image], { allowFail: true });
  }
}

function cleanupSeeded(catalog, pr, owner, firestoreScript, cwd) {
  const seed = seedConfig(catalog, firestoreScript);
  if (!seed) return;
  for (const app of seedApps(catalog)) {
    try {
      runSeed({ catalog, owner, cwd, seed, app, pr, args: ["cleanup", "--pr", String(pr), "--app", app] });
    } catch (err) {
      // Keep tearing down the rest; a later --sweep retries leftovers.
      console.error(`::warning::seed cleanup failed for ${app}: ${err.message}`);
    }
  }
}

/** Delete the data and folders of every PR not in openPrs (leftovers of failed cleanups). */
function sweep(catalog, openPrs, owner, firestoreScript, cwd) {
  const keep = openPrs.map(String);
  const seed = seedConfig(catalog, firestoreScript);
  const apps = seedApps(catalog);
  if (seed && !seed.legacy && apps.length) {
    try {
      runSeed({ catalog, owner, cwd, seed, app: apps[0], pr: null, args: ["sweep", "--keep", keep.join(","), "--apps", apps.join(",")] });
    } catch (err) {
      console.error(`::warning::seed sweep failed: ${err.message}`);
    }
  }
  // pr-N folders are shared by every repo previewing on this host (PR numbers overlap), so only
  // this catalog's apps' folders go, and a pr-N folder only once nothing else is left in it.
  const own = catalog.qaApps.map((a) => a.app).join(" ");
  for (const root of [QA_ASSETS_ROOT, QA_COMPOSE_ROOT]) {
    sh(
      `for d in ${JSON.stringify(root)}/pr-*; do [ -d "$d" ] || continue; n="\${d##*/pr-}"; ` +
        `case ",${keep.join(",")}," in *",$n,"*) continue;; esac; ` +
        `for a in ${own}; do [ -e "$d/$a" ] && echo "removing stale $d/$a" && sudo rm -rf "$d/$a"; done; ` +
        `sudo rmdir "$d" 2>/dev/null || true; done`,
      true,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog, args.cwd);
  if (!args.pr) {
    sweep(catalog, args.open, args.owner, args.firestoreScript, args.cwd);
    return;
  }

  for (const entry of catalog.qaApps) {
    cleanupOne(args.pr, entry.app);
  }
  cleanupSeeded(catalog, args.pr, args.owner, args.firestoreScript, args.cwd);
  // Other repos' previews can share pr-N (PR numbers overlap): only drop the folder once it's empty.
  sh(`sudo rmdir ${JSON.stringify(path.join(QA_COMPOSE_ROOT, `pr-${args.pr}`))} 2>/dev/null || true`, true);
  sh(`sudo rmdir ${JSON.stringify(path.join(QA_ASSETS_ROOT, `pr-${args.pr}`))} 2>/dev/null || true`, true);

  // Per app, so another repo's entries for the same PR number stay.
  for (const entry of catalog.qaApps) {
    run("node", [
      path.join(infraRoot, "scripts/qa/update-active-json.mjs"),
      "remove",
      "--pr",
      String(args.pr),
      "--app",
      entry.app,
    ]);
  }

  if (args.pruneImages) pruneImages(catalog, args.pr, args.owner);
  if (args.sweep) {
    sweep(catalog, args.open.filter((n) => n !== String(args.pr)), args.owner, args.firestoreScript, args.cwd);
  }

  console.log(
    JSON.stringify(
      { ok: true, pr: Number(args.pr), pruned: args.pruneImages },
      null,
      2,
    ),
  );
}

main();

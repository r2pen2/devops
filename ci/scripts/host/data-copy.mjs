#!/usr/bin/env node
/**
 * Overwrite datasets on one host with another host's copy. Use it when the two hosts' data diverged and you've
 * decided which side wins.
 *
 *   node ci/scripts/host/data-copy.mjs --from glados --to bouldergeist --dry-run          # compare only
 *   node ci/scripts/host/data-copy.mjs --from glados --to bouldergeist --only wl-cms,plane-db
 *   node ci/scripts/host/data-copy.mjs --from glados --to bouldergeist                    # every dataset
 *
 * For each dataset (hosts/datasets.json): show both sides (counts, size, newest change), snapshot the target to
 * /opt/services/data/backups/data-copy/, copy, check the target now matches the source, and put the snapshot back
 * if anything fails. Undo a copy later with data-restore.mjs.
 *
 * Refuses to overwrite the ACTIVE host (the one running the tunnel) unless --overwrite-active: that's live data.
 * File datasets stop their containers on the target during the copy; on the source too (for a consistent copy)
 * unless the source is the active host, or --no-stop-source.
 *
 * Also runs as the "Copy data between hosts" GitHub Actions workflow (.github/workflows/data-copy.yml).
 */
import fs from "node:fs";
import { copy, measure, snapshot, restore } from "./datasets.mjs";
import { datasets, guardTarget, host, log, parseArgs, runOk, runsTunnel, stamp, step } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), { from: "string", to: "string", only: "string", dryRun: "bool", overwriteActive: "bool", noStopSource: "bool" });
if (!args.from || !args.to || args.from === args.to) {
  console.error("Usage: data-copy.mjs --from <host> --to <host> [--only a,b] [--dry-run] [--overwrite-active] [--no-stop-source]");
  process.exit(2);
}
const from = host(args.from);
const to = host(args.to);
const wanted = args.only ? new Set(args.only.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const list = datasets().filter((d) => !wanted || wanted.has(d.name));
if (wanted) for (const n of wanted) if (!list.some((d) => d.name === n)) throw new Error(`Unknown dataset "${n}" (hosts/datasets.json)`);

const summary = [`### Copy data ${from.name} → ${to.name}${args.dryRun ? " (dry run)" : ""}`, "", `| Dataset | ${from.name} | ${to.name} before | Result |`, "|---|---|---|---|"];
const writeSummary = () => process.env.GITHUB_STEP_SUMMARY && fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
const esc = (s) => (s || "-").replace(/\|/g, "\\|");
/** Counts that must match after a copy: "3 tables, 120 rows" / "42 files" (sizes and dates may differ). */
const counts = (m) => (m.match(/^[^,]*(,\s*\d+ (rows|documents))?/) || [""])[0];

let failed = false;
try {
  for (const h of [from, to]) if (!runOk(h, "true")) throw new Error(`Can't reach ${h.name} over SSH`);
  if (!args.dryRun) guardTarget(to, { overwriteActive: args.overwriteActive });
  const stopSource = !args.noStopSource && !runsTunnel(from);
  const stampNow = stamp();

  for (const ds of list) {
    const src = measure(from, ds);
    const before = measure(to, ds);
    log(`\n${ds.name} (${ds.type})\n  ${from.name.padEnd(14)} ${src}\n  ${to.name.padEnd(14)} ${before}`);
    if (args.dryRun) {
      summary.push(`| ${ds.name} | ${esc(src)} | ${esc(before)} | would overwrite |`);
      continue;
    }
    if (/^\((missing|no container)\)/.test(src)) {
      log("  skipped: not on the source");
      summary.push(`| ${ds.name} | ${esc(src)} | ${esc(before)} | skipped (not on source) |`);
      continue;
    }
    const snap = snapshot(to, ds, stampNow);
    log(`  snapshot: ${snap || "(nothing there yet)"}`);
    try {
      copy(from, to, ds, { stopSource });
      const after = measure(to, ds);
      if (counts(after) !== counts(src)) throw new Error(`after copy ${to.name} has "${after}", source has "${src}"`);
      log(`  copied: ${after}`);
      summary.push(`| ${ds.name} | ${esc(src)} | ${esc(before)} | ✅ copied (snapshot ${snap ? snap.split("/").pop() : "none"}) |`);
    } catch (err) {
      failed = true;
      log(`  ✗ ${err.message}`);
      if (snap) {
        restore(to, ds, snap);
        log(`  restored ${to.name}'s copy from ${snap}`);
      }
      summary.push(`| ${ds.name} | ${esc(src)} | ${esc(before)} | ❌ ${esc(err.message)}${snap ? "; restored" : ""} |`);
    }
  }
} catch (err) {
  failed = true;
  console.error(`\ndata-copy failed: ${err.message}`);
  summary.push("", `❌ ${err.message}`);
}
writeSummary();
step(failed ? "finished with failures" : args.dryRun ? "dry run: nothing changed" : "done");
process.exit(failed ? 1 : 0);

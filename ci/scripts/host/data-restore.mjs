#!/usr/bin/env node
/**
 * Put a dataset back from a snapshot that data-copy took (the undo button).
 *
 *   node ci/scripts/host/data-restore.mjs --host bouldergeist --dataset wl-cms --list
 *   node ci/scripts/host/data-restore.mjs --host bouldergeist --dataset wl-cms                  # newest snapshot
 *   node ci/scripts/host/data-restore.mjs --host bouldergeist --dataset wl-cms --stamp 20261119-221500
 *
 * Snapshots live on each host in /opt/services/data/backups/data-copy/ (10 kept per dataset). Restoring onto the
 * ACTIVE host needs --overwrite-active.
 */
import { listSnapshots, measure, restore } from "./datasets.mjs";
import { datasets, guardTarget, host, log, parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), { host: "string", dataset: "string", stamp: "string", list: "bool", overwriteActive: "bool" });
if (!args.host || !args.dataset) {
  console.error("Usage: data-restore.mjs --host <host> --dataset <name> [--list | --stamp <stamp>] [--overwrite-active]");
  process.exit(2);
}
const h = host(args.host);
const ds = datasets().find((d) => d.name === args.dataset);
if (!ds) throw new Error(`Unknown dataset "${args.dataset}" (hosts/datasets.json)`);

const snaps = listSnapshots(h, ds);
if (args.list || !snaps.length) {
  log(snaps.length ? snaps.join("\n") : `No snapshots of ${ds.name} on ${h.name}.`);
  process.exit(snaps.length || args.list ? 0 : 1);
}
const file = args.stamp ? snaps.find((s) => s.includes(`-${args.stamp}.`)) : snaps[0];
if (!file) {
  console.error(`No ${ds.name} snapshot with stamp ${args.stamp} on ${h.name}. Have:\n${snaps.join("\n")}`);
  process.exit(1);
}
try {
  guardTarget(h, { overwriteActive: args.overwriteActive });
  log(`${ds.name} on ${h.name} now: ${measure(h, ds)}`);
  restore(h, ds, file);
  log(`restored from ${file}\n${ds.name} on ${h.name} now: ${measure(h, ds)}`);
} catch (err) {
  console.error(`restore failed: ${err.message}`);
  process.exit(1);
}

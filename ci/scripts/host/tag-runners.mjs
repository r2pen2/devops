#!/usr/bin/env node
/**
 * Give every runner in ci/runners.json a `host-<name>` label for the machine it runs on (adds labels only).
 * The original glados runners predate host labels; workflows that must run on a specific host (data-copy.yml
 * runs on the target) select it with `host-<name>`.
 *
 *   node ci/scripts/host/tag-runners.mjs --dry-run
 *   node ci/scripts/host/tag-runners.mjs
 */
import { spawnSync } from "node:child_process";
import { loadJson, log, parseArgs, runnerHost } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), { dryRun: "bool" });
const gh = (a) => {
  const r = spawnSync("gh", a, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${a.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
};
for (const { repo } of loadJson("ci/runners.json").repos) {
  for (const r of JSON.parse(gh(["api", `repos/${repo}/actions/runners?per_page=100`, "--jq", ".runners"]) || "[]")) {
    const h = runnerHost(r);
    if (!h || r.labels.some((l) => l.name === `host-${h}`)) continue;
    log(`${repo}: ${r.name} + host-${h}${args.dryRun ? " (dry run)" : ""}`);
    if (!args.dryRun) gh(["api", "-X", "POST", `repos/${repo}/actions/runners/${r.id}/labels`, "-f", `labels[]=host-${h}`]);
  }
}

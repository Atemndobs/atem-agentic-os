#!/usr/bin/env node
// Jev routing backtest.
//
//   node backtest.mjs extract [--days 30] [--min-turns 2]
//   node backtest.mjs label   [--review 20]
//   node backtest.mjs predict [--sample 100] [--send] [--concurrency 4]
//   node backtest.mjs score   [--threshold-under 0.1]
//   node backtest.mjs run     [--sample 100] [--send]
//
// Nothing leaves this machine unless you pass --send.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extract } from "./lib/extract.mjs";
import { DEFAULT_THRESHOLDS, labelAll } from "./lib/label.mjs";
import { buildPayload, predictAll } from "./lib/jev.mjs";
import { formatReport, score } from "./lib/score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const F = {
  raw: join(OUT, "01-extracted.json"),
  labeled: join(OUT, "02-labeled.json"),
  predicted: join(OUT, "03-predicted.json"),
  report: join(OUT, "04-report.txt"),
  cache: join(OUT, "cache"),
};

function parseArgs(argv) {
  const cmd = argv[2];
  const o = { _: [] };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      o._.push(a);
      continue;
    }
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) o[k] = true;
    else {
      o[k] = /^-?\d+(\.\d+)?$/.test(next) ? Number(next) : next;
      i++;
    }
  }
  return { cmd, o };
}

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
async function writeJson(p, data) {
  await mkdir(OUT, { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2));
}

/** Deterministic sample so reruns compare like with like. */
function sample(arr, n) {
  if (!n || n >= arr.length) return arr;
  const sorted = [...arr].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
  const step = sorted.length / n;
  return Array.from({ length: n }, (_, i) => sorted[Math.floor(i * step)]);
}

async function cmdExtract(o) {
  const root = o.root || join(homedir(), ".claude", "projects");
  process.stderr.write(`scanning ${root} ...\n`);
  const { records, skipped } = await extract({
    root,
    days: o.days ?? 30,
    minTurns: o.minTurns ?? 2,
    includeSynthetic: Boolean(o.includeSynthetic),
  });
  await writeJson(F.raw, records);

  const redacted = records.filter((r) => r.meta.redactions > 0).length;
  console.log(`extracted ${records.length} tasks -> ${F.raw}`);
  console.log(`  skipped: ${skipped.stale} stale, ${skipped.empty} no prompt, ${skipped.tooShort} under min-turns, ${skipped.synthetic} machine-started`);
  console.log(`  ${redacted} digests had at least one redaction applied`);
  return records;
}

async function cmdLabel(o) {
  const records = await readJson(F.raw);
  const labeled = labelAll(records, DEFAULT_THRESHOLDS);
  await writeJson(F.labeled, labeled);

  const dist = {};
  const conf = {};
  for (const r of labeled) {
    dist[r.truth.tier] = (dist[r.truth.tier] || 0) + 1;
    conf[r.truth.confidence] = (conf[r.truth.confidence] || 0) + 1;
  }
  console.log(`labeled ${labeled.length} tasks -> ${F.labeled}`);
  console.log(`  tiers:      ${JSON.stringify(dist)}`);
  console.log(`  confidence: ${JSON.stringify(conf)}`);

  if (o.review) {
    const n = typeof o.review === "number" ? o.review : 20;
    const low = labeled.filter((r) => r.truth.confidence === "low");
    console.log(`\n--- ${Math.min(n, low.length)} borderline tasks to hand-check ---`);
    for (const r of sample(low, n)) {
      const oc = r.outcome;
      console.log(
        `\n[${r.truth.tier}] turns=${oc.assistantTurns} edits=${oc.edits} files=${oc.distinctFiles} ctx=${oc.maxContextTokens}`,
      );
      console.log(`  ${r.digest.request.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return labeled;
}

async function cmdPredict(o) {
  const labeled = await readJson(F.labeled);
  const picked = sample(labeled, o.sample ?? 100);
  const send = Boolean(o.send);

  if (!send) {
    console.log("DRY RUN. Nothing will be sent.");
    console.log(`Writing ${picked.length} payloads to ${F.cache} for review.`);
    console.log("Read a few, then rerun with --send once you are satisfied.\n");
    console.log("--- example payload ---");
    console.log(JSON.stringify(buildPayload(picked[0]), null, 2).slice(0, 900));
  } else {
    console.log(`SENDING ${picked.length} redacted digests to api.typesafe.ai`);
  }

  const { records, stats } = await predictAll(picked, {
    send,
    cacheDir: F.cache,
    concurrency: o.concurrency ?? 4,
  });
  await writeJson(F.predicted, records);

  console.log(
    `\ncached=${stats.cached} called=${stats.called} dryRun=${stats.dryRun} failed=${stats.failed}`,
  );
  if (stats.called) {
    const usd = (stats.inputTokens * 0.042) / 1e6;
    console.log(`  input tokens: ${stats.inputTokens} ($${usd.toFixed(4)})`);
    console.log(`  mean tokens/call: ${Math.round(stats.inputTokens / stats.called)}`);
  }
  return records;
}

async function cmdScore(o) {
  const records = await readJson(F.predicted);
  const s = score(records);
  if (!s.n) {
    console.log("No predictions to score. Run `predict --send` first.");
    return;
  }
  const report = formatReport(s, { thresholdUnder: o.thresholdUnder ?? 0.1 });
  await mkdir(OUT, { recursive: true });
  await writeFile(F.report, report);
  console.log(report);
  console.log(`\nwritten to ${F.report}`);
}

const COMMANDS = {
  extract: cmdExtract,
  label: cmdLabel,
  predict: cmdPredict,
  score: cmdScore,
  async run(o) {
    await cmdExtract(o);
    console.log("");
    await cmdLabel(o);
    console.log("");
    await cmdPredict(o);
    if (o.send) {
      console.log("");
      await cmdScore(o);
    }
  },
};

const { cmd, o } = parseArgs(process.argv);
if (!COMMANDS[cmd]) {
  console.error(`usage: backtest.mjs <${Object.keys(COMMANDS).join("|")}> [options]`);
  process.exit(1);
}
COMMANDS[cmd](o).catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});

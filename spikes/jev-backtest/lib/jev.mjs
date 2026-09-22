// Jev client for the backtest.
//
// Two safety properties matter here more than throughput:
//   1. Nothing leaves the machine without --send. The default builds the exact
//      payloads and writes them to disk so you can read what WOULD be sent.
//   2. Every response is cached on disk by payload hash, so a rerun costs
//      nothing and an interrupted run resumes instead of re-billing.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

// Pin the version. jev-latest can move thresholds under a backtest and make
// two runs incomparable.
export const MODEL = "jev-1.13.0";

export function buildPayload(record) {
  const d = record.digest;
  return {
    model: MODEL,
    state: [
      `project: ${d.project}`,
      d.gitBranch ? `branch: ${d.gitBranch}` : null,
      `request: ${d.request}`,
    ]
      .filter(Boolean)
      .join("\n"),
    questions: {
      tier: {
        type: "choice",
        instructions:
          "A coding agent is about to start this task. Which provider tier should it be routed to?",
        criteria: {
          trivial:
            "a question, a lookup, a one-line answer; no files will be changed",
          mechanical:
            "a rename, a reformat, running a command, reading or searching files; changes are obvious and local",
          implement:
            "writing or changing real logic across one or more files, with edge cases to get right",
          reason:
            "architecture, debugging an unknown cause, weighing tradeoffs, or writing prose where quality matters",
        },
      },
      escalate: {
        type: "noul",
        instructions:
          "Would a small local model produce a materially worse result on this task than a large frontier model?",
      },
    },
  };
}

function hashOf(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function readCache(dir, key) {
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function callJev(payload, { timeoutMs, apiKey }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { error: `HTTP ${res.status}`, body: (await res.text()).slice(0, 400), ms };
    }
    return { ...(await res.json()), ms };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : String(e.message), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Predict a tier for every record.
 *
 * @param {object} opts
 * @param {boolean} opts.send   actually hit the network. Default false.
 * @param {string}  opts.cacheDir
 */
export async function predictAll(records, opts) {
  const { send = false, cacheDir, concurrency = 4, timeoutMs = 10_000 } = opts;
  const apiKey = process.env.TYPESAFE_API_KEY;
  await mkdir(cacheDir, { recursive: true });

  if (send && !apiKey) {
    throw new Error("--send requires TYPESAFE_API_KEY in the environment");
  }

  const stats = { cached: 0, called: 0, dryRun: 0, failed: 0, inputTokens: 0, latencies: [] };
  const out = new Array(records.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= records.length) return;
      const rec = records[i];
      const payload = buildPayload(rec);
      const key = hashOf(payload);

      const hit = await readCache(cacheDir, key);
      if (hit) {
        stats.cached += 1;
        out[i] = { ...rec, jev: hit };
        continue;
      }

      if (!send) {
        // Write the exact bytes that WOULD be sent, so they can be reviewed.
        await writeFile(
          join(cacheDir, `${key}.payload.json`),
          JSON.stringify(payload, null, 2),
        );
        stats.dryRun += 1;
        out[i] = { ...rec, jev: null };
        continue;
      }

      const res = await callJev(payload, { timeoutMs, apiKey });
      stats.called += 1;
      if (res.error) stats.failed += 1;
      if (res.usage?.input_tokens) stats.inputTokens += res.usage.input_tokens;
      if (res.ms) stats.latencies.push(res.ms);

      const entry = {
        tier: res.answers?.tier?.choice ?? null,
        tierConfidence: res.answers?.tier?.confidence ?? null,
        escalate: res.answers?.escalate?.noul ?? null,
        usage: res.usage ?? null,
        ms: res.ms ?? null,
        error: res.error ?? null,
      };
      await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(entry, null, 2));
      out[i] = { ...rec, jev: entry };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
  return { records: out, stats };
}

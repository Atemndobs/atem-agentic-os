#!/usr/bin/env node
// Detached runner for the dsh launcher.
//
// `atem handoff --to dsh` must not block while a (possibly minutes-long) dsh
// session runs, so the launcher spawns this script detached and returns
// immediately. It reads a JSON args file, drives one ACP session, and writes
// a status/result JSON to `outFile` (and again on completion). It never throws
// back to a parent (there is none).
//
// Args file shape:
//   { dshRepo, configPath, workspace, seed, outFile, env?, timeoutMs? }

const fs = require('node:fs');
const { runAcpSession } = require('./dsh-acp.js');

function isoNow() {
  return new Date().toISOString();
}

function safeWrite(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch { /* nothing we can do from a detached process */ }
}

function meta(opts) {
  return { workspace: opts.workspace, dshRepo: opts.dshRepo, outFile: opts.outFile };
}

async function main() {
  const argsFile = process.argv[2];
  if (!argsFile) {
    process.stderr.write('dsh-acp-runner: missing args file\n');
    process.exit(2);
    return;
  }
  let opts;
  try {
    opts = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`dsh-acp-runner: cannot read args: ${err.message}\n`);
    process.exit(2);
    return;
  }

  safeWrite(opts.outFile, { status: 'running', startedAt: isoNow(), ...meta(opts) });

  try {
    const result = await runAcpSession({
      dshRepo: opts.dshRepo,
      configPath: opts.configPath,
      workspace: opts.workspace,
      seed: opts.seed,
      env: { ...process.env, ...(opts.env || {}) },
      timeoutMs: opts.timeoutMs,
    });
    safeWrite(opts.outFile, {
      status: result.ok ? 'done' : 'failed',
      finishedAt: isoNow(),
      ...meta(opts),
      result,
    });
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    safeWrite(opts.outFile, {
      status: 'error',
      finishedAt: isoNow(),
      ...meta(opts),
      error: String((err && err.message) || err),
    });
    process.exit(1);
  }
}

main();

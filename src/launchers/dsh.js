// DeepSeek Harness (dsh) launcher.
//
// dsh is a peer coding-agent harness (see docs/decisions/002-dsh-harness-peer.md).
// ATEM hands off TO dsh by driving its ACP (Agent Client Protocol) automation
// server: initialize -> session/new(cwd = target repo) -> session/prompt(seed).
// The ACP path was chosen over a bespoke CLI wrapper because it generalizes to
// any ACP-speaking agent; see docs/sub-plan-dsh-provider-integration.md and the
// spike in spikes/dsh-acp/.
//
// Two dsh-specific facts shape this launcher:
//   * The ACP server accepts NO MCP servers, so dsh cannot resolve atem:// URLs
//     the way opencode does. We feed the fully-built handoff prompt as the seed;
//     AGENTS.md (already written by commandHandoff) is injected natively by dsh.
//   * A dsh run (especially on a local model) can take minutes, and ACP prompt()
//     blocks until the turn ends. So we spawn a DETACHED runner that drives the
//     session and writes its result to a file, and return immediately. This
//     matches the opencode launcher's fire-and-forget shape.
//
// Config resolution (all overridable by env):
//   ATEM_DSH_REPO         dsh source checkout       (default: ~/sites/deepseek-harness)
//   ATEM_DSH_ACP_CONFIG   cordis composition file   (default: ./dsh-acp.config.yml)
//   OLLAMA_API_KEY        dummy key for the Ollama route (default: "ollama")

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_REPO = path.join(os.homedir(), 'sites', 'deepseek-harness');
const DEFAULT_CONFIG = path.join(__dirname, 'dsh-acp.config.yml');
const RUNNER = path.join(__dirname, 'dsh-acp-runner.js');

function resolveRepo(env) {
  return env.ATEM_DSH_REPO || DEFAULT_REPO;
}
function resolveConfig(env) {
  return env.ATEM_DSH_ACP_CONFIG || DEFAULT_CONFIG;
}
function acpBinPath(repo) {
  return path.join(repo, 'packages', 'examples', 'acp-demo', 'src', 'bin.ts');
}

function sanitizeId(id) {
  return String(id || 'task').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
}

function makeDshLauncher({ spawnFn = spawn, existsFn = fs.existsSync, writeFileFn = fs.writeFileSync, env = process.env } = {}) {
  return {
    name: 'dsh',

    // Sync availability: the dsh source checkout, its ACP bin, and a config
    // file must all be present. When false, dispatch falls back to print.
    available() {
      const repo = resolveRepo(env);
      const cfg = resolveConfig(env);
      return existsFn(repo) && existsFn(acpBinPath(repo)) && existsFn(cfg);
    },

    async launch(input) {
      const repo = resolveRepo(env);
      const cfg = resolveConfig(env);

      if (!existsFn(repo)) {
        return { kind: 'unavailable', reason: `dsh repo not found at ${repo} (set ATEM_DSH_REPO)` };
      }
      if (!existsFn(acpBinPath(repo))) {
        return { kind: 'unavailable', reason: `dsh ACP bin not found under ${repo} (need a built deepseek-harness checkout)` };
      }
      if (!existsFn(cfg)) {
        return { kind: 'unavailable', reason: `dsh ACP config not found at ${cfg} (set ATEM_DSH_ACP_CONFIG)` };
      }
      if (!input.targetRepo || !existsFn(input.targetRepo)) {
        return { kind: 'unavailable', reason: 'targetRepo does not exist' };
      }

      // dsh has no atem:// resolver, so the seed must be self-contained.
      const seed =
        (input.handoffPrompt && input.handoffPrompt.trim()) ||
        `Pick up the ATEM handoff for ${input.syntheticId}. Read AGENTS.md in this repo, then continue the task from where the previous provider left off.`;

      const outDir = (input.paths && input.paths.sessionDir) ? input.paths.sessionDir : os.tmpdir();
      const base = `dsh-run-${sanitizeId(input.syntheticId)}`;
      const outFile = path.join(outDir, `${base}.json`);
      const argsFile = path.join(outDir, `${base}.args.json`);

      const runnerArgs = {
        dshRepo: repo,
        configPath: cfg,
        workspace: input.targetRepo,
        seed,
        outFile,
        // Ollama needs a dummy credential; keep any real key the user already set.
        env: { OLLAMA_API_KEY: env.OLLAMA_API_KEY || 'ollama' },
      };

      try {
        writeFileFn(argsFile, JSON.stringify(runnerArgs, null, 2));
      } catch (e) {
        return { kind: 'unavailable', reason: `could not write dsh runner args: ${e.message}` };
      }

      let child;
      try {
        child = spawnFn('node', [RUNNER, argsFile], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        try { child.unref(); } catch { /* harmless */ }
      } catch (e) {
        return { kind: 'unavailable', reason: `dsh runner spawn failed: ${e.message}` };
      }

      return {
        kind: 'launched',
        summary: `dsh: ACP session started for ${input.syntheticId} at ${input.targetRepo} (pid ${child.pid || 'unknown'}). Result will be written to ${outFile}.`,
        metadata: {
          transport: 'acp',
          dshRepo: repo,
          configPath: cfg,
          workspace: input.targetRepo,
          outFile,
          pid: child.pid || null,
        },
      };
    },
  };
}

module.exports = { makeDshLauncher, resolveRepo, resolveConfig, acpBinPath, DEFAULT_REPO, DEFAULT_CONFIG };

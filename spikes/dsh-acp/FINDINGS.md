# Spike findings: driving DeepSeek Harness over ACP

> Date: 2026-08-21
> Spike A0 from [sub-plan-dsh-provider-integration](../../docs/sub-plan-dsh-provider-integration.md)
> Result: **PASS.** ATEM can drive dsh over ACP stdio with a seed prompt and
> read back a committed answer, backed by a local free model.

## Question

Can an ATEM-side process launch dsh as an ACP (Agent Client Protocol) server
over stdio, open a session on a workspace, send a seed prompt, and collect the
result? This decides whether the future `src/launchers/dsh.js` is a generic ACP
launcher (reusable for any ACP agent) or a bespoke dsh CLI wrapper.

## What was run

- `acp-client.mjs`: an ATEM-side ACP client (stand-in for the launcher). It
  spawns dsh's ACP server, resolves `@agentclientprotocol/sdk` (v0.25.1,
  `PROTOCOL_VERSION = 1`) from the dsh install, and uses `ClientSideConnection`
  to `initialize` → `newSession` → `prompt`, collecting `agent_message_chunk`
  updates and auto-approving any `session/request_permission`.
- `cordis.ollama.yml`: the dsh ACP composition
  (`packages/examples/acp-demo`), with the DeepSeek adapter left idle and an
  `llm-pi-ai` route added for local Ollama (`glm-4.7-flash:latest` at
  `http://localhost:11434/v1`, `openai-completions`). Honors the no-paid-models
  rule.

Command:
```sh
OLLAMA_API_KEY=ollama node spikes/dsh-acp/acp-client.mjs \
  ~/sites/deepseek-harness "List the package directories under packages/. Brief."
```

## Result

```
[initialize] ok: protocolVersion 1, agent "deepseek-harness-acp", authMethods []
[session/new] sessionId=90ab3314-...
[session/prompt] stopReason=end_turn elapsedMs=85905 toolCalls=0
===== COMMITTED ASSISTANT TEXT =====
Package directories under packages/: acp, api, attachment, boot, bundle,
client, code-runtime, compaction, context, core, credentials, e2b, examples,
... workspace.  (accurate 50-dir list)
```

Exit 0. Fully local, no paid key.

## What this proves for ATEM

1. **ACP is the right launcher seam.** The whole flow is standard ACP over
   JSON-RPC stdio: `initialize` (version negotiation) / `session/new`
   (absolute `cwd` = workspace) / `session/prompt` (committed text +
   `stopReason`). A `src/launchers/dsh.js` built on `@agentclientprotocol/sdk`
   `ClientSideConnection` is small, and the same code path serves any future
   ACP-speaking agent (Zed ecosystem, Gemini CLI, etc.), not just dsh. This is
   more leverage than a per-provider CLI wrapper.
2. **Non-interactive by design.** `requestPermission` is answered
   programmatically (we auto-selected `allow_once`), which is exactly what an
   automated ATEM handoff needs. No human picker in the loop.
3. **Workspace = session cwd.** `session/new` takes the absolute workspace
   path, so ATEM points dsh at the target repo per handoff, matching how the
   other launchers pass `--dir` / cwd.
4. **Model routing is config, not code.** Backing dsh with a local or allowed
   provider is a `cordis` row (`llm-pi-ai` + `apiKeyEnv`), so ATEM can keep the
   no-paid-models rule without touching dsh source.

## Gotchas found

- **pi-ai needs a credential reference even for Ollama.** A declared route
  fails with `No API key for provider: ollama` unless `apiKeyEnv` is set; a
  dummy `OLLAMA_API_KEY=ollama` satisfies it.
- **stdout is protocol-pure.** dsh diagnostics go to stderr; the launcher must
  not read stdout as anything but ACP frames.
- **Fresh sessions only.** The ACP demo does not support load/resume/fork
  (`Known Limitations`). So `atem handoff --from dsh` (ingesting an existing dsh
  session) cannot ride ACP session-resume; it must read the persisted event log
  / `~/.dsh` state instead. ACP is the outbound (`--to dsh`) path.
- **ACP suppresses tool/reasoning updates by design** ("committed answers
  only"), so `toolCallCount` is usually 0 even when tools ran. Confirmed
  separately: a task forcing `ls -1 packages | wc -l` returned exactly `55`
  (the real count, and different from the model's from-context guess of 50),
  proving dsh executed a sandboxed bash tool inside the ACP session. For a real
  trajectory, read dsh's persisted session under `$DSH_HOME`, not this stream.

## Done (promotion)

- Tool execution over ACP: confirmed (`55`).
- Promoted into a real launcher: `src/launchers/dsh.js` (+ reusable
  `dsh-acp.js`, detached `dsh-acp-runner.js`, canonical `dsh-acp.config.yml`),
  registered in the launcher registry, unit-tested, and smoke-tested end to end
  (detached runner wrote `status: done, text: "55"`).

## Next

- `src/adapters/dsh.js` for detection/ingest, reading `~/.dsh` state (the
  `--from dsh` path, since the ACP demo is fresh-sessions-only).

## Files

- `acp-client.mjs`: the ATEM-side ACP client stand-in.
- `cordis.ollama.yml`: dsh ACP composition backed by local Ollama.

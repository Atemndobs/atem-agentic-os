# Trending Agent Repositories: Machine-Wide Assessment

Date: 2026-07-24

## Scope

This assessment treats the repositories featured in The Next New Thing's
2026-07-10 roundup as a set, rather than assuming that one repository should be
adopted wholesale. It compares their current public repositories with:

- ATEM and its local web UI;
- the coding-agent tools installed on this Mac;
- the projects and worktrees under `/Users/atem/sites`;
- the voice, language, operations, job-search, and homelab work already in
  progress.

The repositories were reviewed through their current GitHub metadata, README
files, repository trees, and selected implementation and architecture files.
This is an architectural assessment, not a security certification.

## Executive conclusion

The most useful repository in the set for ATEM is not a single winner. Four
projects contain complementary ideas that should become part of ATEM's design:

1. [shadcn/improve](https://github.com/shadcn/improve) provides the best
   execution-plan contract.
2. [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) provides
   the best small, inspectable model for durable delegated jobs and structured
   review gates.
3. [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) provides the
   clearest boundary between agent continuity and terminal/process
   multiplexing.
4. [steipete/CodexBar](https://github.com/steipete/CodexBar) provides the best
   privacy and consent model for local agent observability.

[diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) contains
valuable resilience vocabulary, but its operational and security surface is
too large to place in the critical path now. Borrow its circuit-breaker and
routing concepts; do not make it ATEM's foundation.

Across the rest of the computer, the two highest-value additions to evaluate
are:

- [bradautomates/claude-video](https://github.com/bradautomates/claude-video)
  as a reusable video-understanding capability for every project; and
- [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily)
  as a local-first meeting capture and transcription system.

## The architectural boundary to preserve

ATEM should remain the durable continuity and control plane:

- what the task is;
- who owns it;
- which provider or worktree is active;
- what decisions and evidence must survive a handoff;
- what the next provider must do;
- whether the handoff is healthy, stale, blocked, or complete.

ATEM should not become all of the following:

- a PTY and terminal multiplexer;
- an LLM traffic proxy;
- a full observability scraper for every provider;
- a browser automation runtime;
- a penetration-testing platform;
- a media decoding pipeline.

Those are integration surfaces. ATEM should normalize their state and launch
them, not absorb their implementations.

## What ATEM should adopt

### 1. Executable handoff plans from `shadcn/improve`

`improve` treats the plan as the product. Its strongest idea is not
"use a strong model to plan and a cheap model to code"; it is that delegation
only works when the receiving agent can execute without access to the planning
conversation.

Its plan contract includes:

- the Git commit against which the plan was written;
- exact in-scope and out-of-scope files;
- current-state excerpts and repository exemplars;
- ordered implementation steps;
- a verification command and expected result for every step;
- explicit STOP conditions;
- machine-checkable completion criteria;
- a plan index with dependencies and status;
- reconciliation when code or plans drift;
- a reviewer verdict of approve, revise, or block.

ATEM already carries briefs, state, decisions, handoffs, and next actions. It
should add an optional executable-plan section rather than invent another
parallel planning directory:

```yaml
execution:
  planned_at_commit: <sha>
  executor_profile: <capabilities, not a vendor model name>
  scope:
    include: []
    exclude: []
  steps:
    - id: step-1
      action: ...
      verify:
        command: ...
        expected: ...
  stop_conditions: []
  evidence: []
  verdict: pending | approve | revise | block
```

This would improve every repository on the Mac, especially the many parallel
Curator, Nweh Lingo, and Ops Central worktrees. A handoff would become
executable and auditable, not merely descriptive.

Important adaptation: do not copy `improve`'s Claude-specific subagent
instructions. Preserve the provider-neutral contract and let ATEM's adapter
layer choose the executor.

### 2. Durable delegated jobs from `openai/codex-plugin-cc`

The Codex plugin is unusually relevant because it solves a smaller version of
ATEM's hardest reliability problem: a second agent runs asynchronously, and
the originating environment must later find its status and result.

Useful implementation patterns:

- state is namespaced by a canonical workspace path plus a stable hash;
- a bounded state index and one durable file per job are maintained;
- jobs have explicit `running`, `completed`, and `failed` states;
- phase, PID, timestamps, thread ID, turn ID, log path, result, and error are
  recorded;
- foreground and background execution share the same job lifecycle;
- status, result, and cancellation are separate commands;
- transcript imports are constrained to a known source root;
- structured review output is validated against JSON Schema;
- an optional stop-review gate fails closed on invalid or unexpected output.

This directly supports the unfinished ATEM work identified in the archived
handoff:

- build a real Codex transcript/session distiller;
- diagnose Codex sidebar/archive visibility separately from data loss;
- expose durable delegated-job status;
- distinguish provider UI state from ATEM's source of truth.

ATEM should not copy the plugin's temporary-directory fallback or its
Claude-specific hook system. It should bring the job lifecycle into the ATEM
session schema and store provider-native IDs as observations.

Recommended separation:

```text
durable intent/state       ATEM session files
provider-native evidence   rollout JSONL, SQLite rows, Claude transcripts
runtime observation        PID, terminal state, last activity, quota health
UI visibility              sidebar/cache hints; never a source of truth
```

### 3. Runtime integration, not duplication, from `herdr`

Herdr is a Rust terminal workspace manager built around PTYs, a TUI, local IPC,
persistence, remote operation, plugins, notifications, worktrees, and
agent-specific state detection. It overlaps with ATEM at the user-experience
level but not at the source-of-truth level.

The correct relationship is:

```text
ATEM: task identity, intent, handoff, decisions, ownership, recovery
Herdr: terminal sessions, panes, PTYs, process lifecycle, operator attention
```

ATEM should eventually have a Herdr adapter that can:

- launch or focus a Herdr workspace for an ATEM task;
- associate a Herdr workspace/session ID with an ATEM session;
- read Herdr's socket API for runtime status;
- surface "agent waiting for input", "working", "finished", and "terminal
  exited" as observations;
- deep-link from the ATEM web UI to the terminal workspace.

ATEM should not implement its own PTY stack, terminal emulator, or remote
multiplexer. Herdr already carries the platform-specific complexity, including
Windows process and console handling.

This is especially useful on this Mac because Claude Code, Codex, OpenCode,
Cursor Agent, Aider, and Gemini are all installed. ATEM knows why work is
moving; Herdr can show where it is running.

### 4. Consent-aware observability from `CodexBar`

CodexBar reads provider usage, known configuration locations, bounded local
logs, and optionally running-process information. Its most transferable idea
is its privacy boundary:

- do not crawl the filesystem;
- enumerate each known location and purpose;
- ask before reading process command lines or agent session metadata;
- degrade gracefully when consent is declined;
- retain only the minimum activity data needed;
- keep credentials in protected local storage;
- put every provider behind a normalized adapter and snapshot.

ATEM's UI can use this approach for a provider-health strip:

- last known activity;
- provider availability;
- quota or rate-limit pressure when available;
- running/waiting/finished state;
- freshness and source of the observation;
- permissions used to obtain it.

Provider activity must remain an observation. It must never silently rewrite
task ownership or completion.

### 5. Resilience vocabulary from `OmniRoute`

OmniRoute's useful contribution is a mature distinction between different
failure domains:

- provider-wide circuit breaker;
- connection/account cooldown;
- model lockout;
- queue admission and concurrency limits;
- session affinity;
- task-aware candidate scoring;
- last-known-good routing;
- sanitized errors for users and detailed errors only in local logs.

ATEM can adapt this without becoming an inference proxy:

| OmniRoute concept | ATEM adaptation |
|---|---|
| `CLOSED / DEGRADED / OPEN / HALF_OPEN` | provider adapter health |
| account cooldown | one credential/account temporarily unavailable |
| model lockout | requested capability unavailable |
| session affinity | prefer continuing with the provider that owns context |
| task fitness | route by task type and provider capability |
| queue admission | cap concurrent expensive or conflicting tasks |
| last known good | fall back to a recently successful compatible provider |
| sanitized response | concise UI error plus local diagnostic evidence |

Routing should be explainable. A future ATEM routing decision should record the
candidate set, rejected candidates, chosen provider, health signals, task fit,
and any user override.

Do not install OmniRoute into the default coding-agent path yet. Its very broad
provider surface, credential handling, optional traffic interception, memory,
compression, and routing features create a much larger trust boundary than
ATEM currently needs. If evaluated, run it as an isolated homelab pilot with
test credentials, no transparent MITM, and explicit before/after quality and
cost measurements.

## Repository-by-repository verdict

| Repository | Verdict | What to learn or use |
|---|---|---|
| `shadcn/improve` | Adopt the contract now | Commit-stamped plans, exact scope, verification gates, STOP conditions, reconciliation, independent review |
| `openai/codex-plugin-cc` | Study and adapt now | Durable jobs, background result retrieval, transcript constraints, structured review schema, stop gate |
| `ogulcancelik/herdr` | Integration candidate | PTY/process ownership, TUI runtime, IPC, attention states; do not rebuild inside ATEM |
| `steipete/CodexBar` | Adopt privacy patterns; optionally install separately | Provider adapters, usage snapshots, bounded reads, explicit process-inspection consent |
| `diegosouzapw/OmniRoute` | Lab-only evaluation | Health models, circuit breakers, task-aware routing, cost/latency signals, error sanitization |
| `bradautomates/claude-video` | High-value machine-wide pilot | Reusable video ingestion with captions, Whisper fallback, scene/keyframe selection, deduplication, token budgets |
| `Zackriya-Solutions/meetily` | Evaluate as a local tool | Private local transcription, diarization, local storage, Ollama summaries |
| `usestrix/strix` | Use only in isolated authorized targets | Dynamic validation and proof-based security findings; never point it casually at production or the homelab |
| `StarTrail-org/PixelRAG` | Targeted research pilot | Retrieval over visual layout when screenshots carry evidence that DOM/text extraction loses |
| `alibaba/page-agent` | Product-specific pilot | In-page natural-language control for admin tools; not an ATEM core dependency |
| `facebook/astryx` | Borrow interaction patterns | Agent-ready tables, wizards, detail views, themes; avoid wholesale StyleX migration |
| `MadsLorentzen/ai-job-search` | Directly useful for job projects | Structured candidate profile, job evaluation, evidence-backed application workflow |
| `asgeirtj/system_prompts_leaks` | Reference corpus only | Compare orchestration and safety patterns; do not treat leaked prompts as authoritative, stable, or cleanly licensed product requirements |

## Machine-wide application map

### ATEM and `atem-agentic-os-ui`

Use:

- `improve` for the next-generation task/execution contract;
- `codex-plugin-cc` for provider-derived jobs and review gates;
- Herdr for terminal runtime integration;
- CodexBar for provider usage and activity adapters;
- OmniRoute's health vocabulary for explainable routing;
- Astryx's table/detail/wizard patterns for the UI.

The archived ATEM session also confirms that the UI and Codex visibility work
already need these exact concepts. Missing sidebar presence is not deletion;
ATEM needs a diagnostic view that shows session files, rollout files, SQLite
state, archive state, workspace hints, and deep links as separate layers.

### Curator worktrees

Use `improve`'s drift-aware plans and review loop for parallel commercial,
audio, and subscription work. Use Strix only against a disposable or explicitly
authorized staging target. The media skill could inspect competitor demos or
long-form product feedback, but it should not enter the app runtime.

### Nweh Lingo, SpeakIt, Voicebox, and language/audio work

The strongest reusable media pipeline is:

```text
source
  -> captions if available
  -> local or API transcription fallback
  -> timestamped segments
  -> scene/keyframe candidates
  -> near-duplicate removal
  -> token-budgeted evidence bundle
  -> agent analysis
```

`claude-video` implements this with focused time ranges, transcript-cue frames,
frame budgets, efficient/balanced/high-detail modes, and explicit reporting of
what was omitted. Those ideas should inform any Nweh Lingo video lesson,
pronunciation, or media-understanding feature.

Meetily is relevant when local recording privacy matters. Reuse its local-first
principle and evaluate its transcription stack before building another meeting
capture system.

### Job4me and the CV website

`ai-job-search` is directly applicable. Its strongest product insight is that
the durable asset is not a generated cover letter; it is a deep candidate
profile, structured evidence, search criteria, job evaluations, and an
application tracker. Job4me should keep those as inspectable data and generate
documents from them.

### Ops Central and JNA Cleaners

Page Agent is a plausible experiment for natural-language operation of dense
admin workflows, such as locating a property, filling a form, or navigating a
multi-step task. Keep the integration in-page and permissioned. Do not let a
page agent become a bypass around backend authorization or audit logs.

Astryx is more valuable here as an interaction-pattern library than as a
dependency: table pages, detail pages, filters, form wizards, and explicit
agent-action affordances.

### Photo Menu, document, and visual projects

PixelRAG is worth testing where spatial layout is the evidence: menus,
brochures, PDFs, dashboards, or screenshots. It should complement, not replace,
text and DOM retrieval. Run an evaluation set first and compare retrieval
accuracy, latency, storage, and model cost.

### OpenClaw, Archon, Hermes Agent, Paperclip, Symphony, and the homelab

These are the best candidates for a controlled OmniRoute experiment because
they already sit near agent/model infrastructure. Keep the first experiment
read-only and local:

- two providers;
- test credentials;
- no TLS interception;
- no production prompts;
- explicit health and latency metrics;
- deterministic fallback tests;
- a kill switch and clean rollback.

Do not route every coding tool through it until quality, privacy, and failure
behavior are measured.

### Every web-facing project

Strix's important idea is proof-based security validation rather than
unconfirmed scanner output. The operational rule is equally important: only
scan systems that are explicitly authorized, preferably local disposable
environments. Start with conventional dependency, static, unit, and integration
security checks; use an autonomous pentester as a gated later stage.

## Recommended sequence

### Now: design changes, no new runtime dependency

1. Add the executable-plan fields to the ATEM schema and UI design.
2. Design provider observations separately from durable ATEM state.
3. Specify a tracked-job lifecycle and structured review result.
4. Add provider-health semantics and an explainable routing record.
5. Add a privacy/consent matrix for every local source ATEM may inspect.

### Next: narrow integrations

1. Implement the Codex provider distiller and visibility diagnostic.
2. Add a Herdr adapter spike against its socket API.
3. Add a read-only provider activity/usage adapter, inspired by CodexBar.
4. Pilot the video skill on one real research video and measure the evidence
   quality and token cost.
5. Evaluate Meetily separately as a desktop tool, not an ATEM component.

### Later: isolated experiments

1. Test PixelRAG on a small visual-document benchmark.
2. Test Page Agent inside one non-sensitive admin workflow.
3. Run Strix only against an explicitly authorized disposable target.
4. Test OmniRoute in an isolated homelab environment before considering any
   coding-agent configuration changes.

## What not to do

- Do not turn ATEM into a monolithic agent platform.
- Do not infer task completion from a process exiting or a sidebar entry
  disappearing.
- Do not install a global inference proxy merely to gain failover.
- Do not enable transparent traffic interception on this Mac.
- Do not expose provider tokens, transcript contents, process command lines, or
  project paths without a documented purpose and consent.
- Do not run autonomous offensive security tooling against production, third
  parties, or the homelab by default.
- Do not replace semantic text retrieval with screenshots everywhere.
- Do not copy leaked system prompts into production policy.
- Do not adopt a design system whose build stack conflicts with a project just
  for visual consistency.

## The single most valuable lesson

The common pattern behind the best repositories is not "more agents." It is a
strong boundary around delegated work:

```text
intent
  -> explicit plan
  -> bounded executor
  -> durable runtime state
  -> observable evidence
  -> independent verification
  -> reconciled outcome
```

ATEM is already positioned to own that boundary across providers and projects.
The opportunity is to make its contracts more executable and its observations
more reliable, while continuing to delegate terminals, model routing, media
processing, browser control, and security testing to focused tools.

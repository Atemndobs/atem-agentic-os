# Sub-Plan: `atem status` Ergonomics — Idle Detection + Repo Scoping

> Parent: `docs/action-plan.md` — extends Workstream 1 (Task Intent) and
> Workstream 5 (Session Graph & Routing) lightly.
> Builds on: ambient-tasks sub-plan + claude-code adapter (both shipped).
> Status: **Complete 2026-06-01** — C.1 + C.2 + C.3 shipped, 66/66 tests pass.
> Ordering: C.1 → C.2 → C.3, shipped in one pass.

---

## Why this plan exists

`atem status` works but it answers the *wrong default question*:

1. **Live-only.** Close Claude Code at end of day → tomorrow morning,
   `atem status` shows nothing about yesterday's work — even though
   every transcript still sits on disk.
2. **Machine-wide by default.** Inside a repo I almost always care about
   *this* repo. Today I have to type `--repo .` every time.

Both are friction. Both are cheap to fix. They overlap — both touch
`collectAmbientTasks` and `printExternalProviderActivity` — so they
ship together as one sub-plan.

---

## Goal

> `cd ~/sites/foo && atem status` answers "what was I doing here, live
> or recent?" — without flags, without missing anything important, and
> with one clear escape hatch (`--all`) when I want the whole machine.

---

## Phase C.1 — Idle ambient detection

### What

Detect sessions whose **process is gone but transcript was touched
recently**. Default window: 48h (covers Friday → Monday). Configurable
via `ATEM_RECENT_WINDOW_HOURS=NN`.

### Tasks

**T C.1.1 — Shared window helpers in `src/synthetic.js`**
- `getRecentWindowMs()` → reads env, default 48 * 60 * 60 * 1000.
- `isRecent(mtimeMs, now = Date.now())` → boolean.
- `formatRelativeAge(mtimeMs, now)` → `"5m ago" | "3h ago" | "2d ago"`.

**T C.1.2 — `listRecentSessions` on the claude-code adapter**
- Scans `~/.claude/projects/<dir>/<sessionId>.jsonl` by `stat.mtimeMs`.
- Skips files older than the window without parsing.
- Returns `{ sessionId, cwd (from project dir name), title (lazy), file, mtimeMs }`.

**T C.1.3 — Wire idle results into `getClaudeSessions`**
- Live detection unchanged (pid registry).
- After live, append idle entries from `listRecentSessions` minus any
  whose `sessionId` is already in the live set.
- Each result carries `live: bool`, `mtimeMs`, and existing fields.

**T C.1.4 — Reuse the shared window for omp**
- `getOmpSessions` already has its own 12h constant. Replace with
  `getRecentWindowMs()`.

---

## Phase C.2 — Auto-repo scoping

### What

When `atem status` runs **inside a git repo** and neither `--repo` nor
`--all` was passed, default to scoping the output to that repo.

### Tasks

**T C.2.1 — `parseStatusArgs` learns `--all`**
- Boolean flag. Skips auto-scoping when present.

**T C.2.2 — `commandStatus` picks the default scope**
- If explicit `--repo PATH` → use it (today's behavior).
- Else if `--all` → no scope.
- Else if `gitRoot` is non-null → use `gitRoot` as the implicit scope.
- Else → no scope.

**T C.2.3 — Banner reflects scope**
- Today: `Machine-wide provider activity (N signals)`.
- New: `Provider activity in <repo> (auto-scoped — pass --all for machine-wide)`
  or `Provider activity (machine-wide)` when `--all`.

---

## Phase C.3 — Combined display

### What

State column reflects live/idle/age. Dedup by `(provider, cwd)` so two
abandoned Claude sessions for the same repo show once (newest wins).
Show how many were elided so the user never wonders.

### Tasks

**T C.3.1 — State column rendering**
- Live → `✓ live`.
- Idle → `· 3h ago`, `· 2d ago`.

**T C.3.2 — `collectAmbientTasks` dedupes by `(provider, cwd)`**
- Sort by live (live first), then `mtimeMs` desc.
- First entry per `(provider, cwd)` wins. Rest are *elided*, not dropped:
  - The dedup function returns `{ kept, elidedCount }`.

**T C.3.3 — Repo scope filter applied AFTER dedup**
- When scope is set, also filter ambient rows by `cwd === scope`
  (or path-within). Count what's hidden by the scope, surface it as
  `(N session(s) in other repos hidden; pass --all to see)`.

**T C.3.4 — Footer line**
- After the table:
  - `Same repo, deduped: N elided`
  - `Other repos: M hidden`
  - Empty when both are zero.

---

## Out of scope (explicit)

- Codex / Cursor transcript discovery — separate sub-plan once their
  on-disk session-store layout is researched.
- Configurable per-provider windows. One window for all.
- Surfacing idle sessions in `atem://` synthetic resolution differently —
  the URL resolver already works on any session whose transcript exists,
  whether the process is alive or not.

---

## Execution order

```
C.1.1 → C.1.2 → C.1.3 → C.1.4    (idle detection)
                  ↘
C.2.1 → C.2.2 → C.2.3            (scope)
                  ↘
C.3.1 → C.3.2 → C.3.3 → C.3.4    (display)
```

All three phases in one PR; tests live in `test/status-ergonomics.test.js`.

---

## Success criteria

- Closing Claude Code does **not** make my session disappear from
  `atem status` for the next 48h.
- Running `atem status` inside `~/sites/foo` shows only sessions
  with cwd inside `~/sites/foo` — by default.
- `atem status --all` reproduces today's machine-wide behavior.
- `atem status --repo ~/elsewhere` still works (explicit wins).
- Same-repo, multi-session noise (e.g., three abandoned Claude
  sessions in one repo) collapses to one row with `N elided`.

---

## First move

T C.1.1 — three trivial helpers in `src/synthetic.js`. The rest builds
on top.

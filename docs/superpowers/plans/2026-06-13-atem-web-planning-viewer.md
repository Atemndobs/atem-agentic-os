# `atem web` Planning Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-dependency `atem web` command that serves an interactive SPA for reading all agent planning files (ATEM task files + planning docs of every project on this machine) as formatted HTML, with search and live reload.

**Architecture:** Three new modules under `src/web/` — `markdown.js` (MD→HTML renderer), `scan.js` (machine-wide document discovery via agent registries), `server.js` (node:http + SSE + embedded SPA client in `app.html`) — wired into `src/cli.js` as `commandWeb()`. Spec: `docs/superpowers/specs/2026-06-13-planning-web-viewer-design.md`.

**Tech Stack:** Node ≥20 built-ins only (`node:http`, `node:fs`, `node:path`, `node:os`). Tests with `node:test` + `node:assert/strict`, using the repo's temp-HOME harness pattern. No npm dependencies.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/web/markdown.js` | Pure function `render(md)` → `{ html, frontmatter }`. HTML-escapes everything; supports the constructs in the spec. No fs, no state. |
| `src/web/scan.js` | `discoverRoots(opts)` (agent registries → project roots), `decodeClaudeProjectDir(encoded, existsFn)` (dash-path decoder), `buildTree(opts)` → `{ docs, groups }`. Reads fs; all roots injectable via opts/env for tests. |
| `src/web/server.js` | `createServer(opts)` → node:http server with routes `/`, `/api/tree`, `/api/doc`, `/api/search`, `/events`; owns rescan + fs.watch + SSE broadcast. |
| `src/web/app.html` | The entire SPA client (HTML+CSS+JS inline). Served verbatim by `/`. |
| `src/cli.js` | Add `case 'web'` + `commandWeb(gitRoot, args)` + usage line. |
| `test/web-markdown.test.js`, `test/web-scan.test.js`, `test/web-server.test.js`, `test/web-cli.test.js` | One test file per module + CLI smoke test. |

Env overrides (all used only by `scan.js`/`server.js`, defaulting to real locations):
`ATEM_HANDLES_DIR` (already exists), `ATEM_WEB_CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`), `ATEM_WEB_CODEX_SESSIONS_DIR` (default `~/.codex/sessions`), `ATEM_WEB_WATCH_DIR` (default `~/.atem/harness/sessions`).

---

### Task 1: Markdown renderer (`src/web/markdown.js`)

**Files:**
- Create: `src/web/markdown.js`
- Test: `test/web-markdown.test.js`

- [ ] **Step 1: Write failing tests** — one test per construct:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/web/markdown.js');

test('escapes raw HTML', () => {
  assert.match(render('<script>x</script>').html, /&lt;script&gt;/);
  assert.doesNotMatch(render('<script>x</script>').html, /<script>/);
});
test('headings h1-h6 with ids', () => {
  const { html } = render('# Title\n###### Deep');
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<h6 id="deep">Deep<\/h6>/);
});
test('fenced code with language, no inline formatting inside', () => {
  const { html } = render('```js\nconst a = "**x**";\n```');
  assert.match(html, /<pre><code class="lang-js">/);
  assert.match(html, /\*\*x\*\*/); // not bolded
});
test('inline code protects content', () => {
  assert.match(render('use `a*b*c` here').html, /<code>a\*b\*c<\/code>/);
});
test('GFM table', () => {
  const { html } = render('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html, /<table>[\s\S]*<th>A<\/th>[\s\S]*<td>1<\/td>/);
});
test('nested and task lists', () => {
  const { html } = render('- a\n  - b\n- [x] done\n- [ ] todo');
  assert.match(html, /<ul>[\s\S]*<ul>[\s\S]*b/);
  assert.match(html, /checked/);
  assert.match(html, /checkbox/);
});
test('ordered list', () => {
  assert.match(render('1. one\n2. two').html, /<ol>[\s\S]*<li>one<\/li>/);
});
test('blockquote, hr', () => {
  assert.match(render('> quoted').html, /<blockquote>/);
  assert.match(render('---\ntext').html, /<hr/);
});
test('links, images, emphasis, strikethrough', () => {
  const { html } = render('[t](http://x) ![i](http://y.png) **b** *i* ~~s~~');
  assert.match(html, /<a href="http:\/\/x"/);
  assert.match(html, /<img src="http:\/\/y.png"/);
  assert.match(html, /<strong>b<\/strong>.*<em>i<\/em>.*<del>s<\/del>/);
});
test('javascript: URLs are neutralized', () => {
  assert.doesNotMatch(render('[x](javascript:alert(1))').html, /href="javascript:/);
});
test('frontmatter extracted, not rendered as body', () => {
  const { html, frontmatter } = render('---\nstatus: active\nrepo: /x\n---\n# Body');
  assert.equal(frontmatter.status, 'active');
  assert.doesNotMatch(html, /status: active/);
  assert.match(html, /<h1/);
});
test('plain paragraphs joined, unknown constructs degrade to text', () => {
  assert.match(render('hello\nworld').html, /<p>hello\nworld<\/p>/);
});
```

- [ ] **Step 2: Run** `node --test test/web-markdown.test.js` — expect FAIL (module not found).
- [ ] **Step 3: Implement `src/web/markdown.js`.** Single-pass line-based block parser + inline pass. Shape:

```js
// Markdown → HTML for the planning viewer. Zero-dep by design: planning
// docs are machine-generated, so a small predictable renderer beats a
// dependency. Unknown constructs must degrade to escaped text.
function escapeHtml(s) { /* & < > " ' */ }
function slugify(s) { /* lowercase, non-alnum → '-' */ }
function safeUrl(u) { /* allow http(s), mailto, #, relative; else '#' */ }
function renderInline(text) {
  // 1. escape; 2. extract `code` spans into placeholders;
  // 3. images ![alt](url); 4. links [t](url) via safeUrl;
  // 5. **bold**, *italic*, ~~strike~~; 6. restore code spans.
}
function parseFrontmatter(md) { /* leading --- block → {data, body}; key: value pairs only */ }
function render(md) {
  // blocks: fence (```lang … ```), heading (#{1-6} + id=slugify),
  // hr (---/***), blockquote (> recursive render), table (header+|---|),
  // lists (stack-based nesting by 2-space indent; ordered 1. / bullet -/*;
  // task [- [x]] → <input type="checkbox" disabled checked?>),
  // paragraph fallback. Returns { html, frontmatter }.
}
module.exports = { render, escapeHtml, renderInline, parseFrontmatter };
```

- [ ] **Step 4: Run** `node --test test/web-markdown.test.js` — expect PASS.
- [ ] **Step 5: Commit** `feat(web): markdown renderer`

### Task 2: Discovery + tree (`src/web/scan.js`)

**Files:**
- Create: `src/web/scan.js`
- Test: `test/web-scan.test.js`

- [ ] **Step 1: Write failing tests** with fixture dirs (temp dir per test):

```js
// Fixtures: tmp/handles/TASK-001/{brief,state,...}.md (+ _archive/, current symlink ignored),
// tmp/claude-projects/<encoded-name>/ for decoder cases,
// tmp/codex-sessions/2026/06/13/x.jsonl with session_meta first line,
// tmp/projects/alpha/.planning/ROADMAP.md, tmp/projects/alpha/PLAN.md, AGENTS.md.
test('decodeClaudeProjectDir resolves dashes via existence checks', ...);
//   '-Users-x-my-app' with fs mock where /Users/x/my-app exists → '/Users/x/my-app'
//   '--claude' segment → '/.claude'; undecodable → null
test('buildTree lists tasks excluding _archive and current', ...);
test('task docs are the seven canonical files with stable order', ...);
test('provider derived from handle prefix; bare TASK ids have provider null', ...);
test('codex cwd extracted from session_meta lines', ...);
test('project scan finds .planning/**, PLAN.md, AGENTS.md, docs/sub-plans, uncapped', ...);
test('projects without planning docs are omitted; /tmp roots skipped; dedupe via realpath', ...);
test('doc ids are sequential and unique across groups', ...);
```

- [ ] **Step 2: Run** `node --test test/web-scan.test.js` — FAIL.
- [ ] **Step 3: Implement.** Key pieces:

```js
const TASK_FILES = ['brief', 'state', 'next', 'decisions', 'validation', 'log', 'handoff'];

function decodeClaudeProjectDir(encoded, exists = fs.existsSync) {
  // '-Users-atem-sites-atem-agentic-os--claude-worktrees-x'
  // DFS over segments; at each step try [join with '/', join with '-'];
  // empty segment means the next join is '/.<seg>'.
  // Only accept steps where exists(candidate) is true; return first full match or null.
}
function discoverRoots({ claudeProjectsDir, codexSessionsDir, atemTaskIds, extraRoots }) {
  // claude: readdir(claudeProjectsDir) → decode each
  // codex: walk codexSessionsDir for *.jsonl, read first line (≤4KB),
  //        JSON.parse → payload.cwd (tolerate parse errors)
  // atem: session.listRepos(taskId) per task (wrap in try/catch)
  // + extraRoots (cwd repo). realpath-dedupe; drop missing and /tmp|/private/tmp.
}
function scanProjectDocs(root) {
  // walk: .planning/** (recursive, .md only), docs/sub-plans/*.md,
  // docs/research/*.md, docs/decisions/*.md, ADR|adr|docs/adr/*.md,
  // + files: docs/PLAN.md, docs/action-plan.md, PLAN.md, AGENTS.md,
  //   PROJECT.md, ROADMAP.md (PURPOSE_CANDIDATES from context.js).
  // Dedupe by relative path; cap recursion depth 6; skip node_modules/.git.
}
function buildTree(opts) {
  // → { docs: [{id, path, title, nodeKey, group, file, mtime}],
  //     groups: [{kind:'tasks', nodes:[{key,label,provider,docs:[ids]}]},
  //              {kind:'projects', nodes:[{key,label,root,docs:[ids]}]}] }
  // Title = first '# ' heading or filename. Sorted: tasks by mtime desc, projects by label.
}
module.exports = { buildTree, discoverRoots, decodeClaudeProjectDir, scanProjectDocs, TASK_FILES };
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(web): machine-wide planning doc discovery`

### Task 3: HTTP server (`src/web/server.js`)

**Files:**
- Create: `src/web/server.js`
- Test: `test/web-server.test.js`

- [ ] **Step 1: Failing tests** (real server on port 0, global `fetch`):

```js
test('GET / serves the SPA shell', ...);          // contains 'atem-web-app' marker
test('GET /api/tree returns groups + generation', ...);
test('GET /api/doc?id=0 returns html, raw, path, mtime', ...);
test('doc html contains rendered heading from fixture', ...);
test('GET /api/doc with bad id → 404 JSON', ...); // id='999', id='../../etc/passwd', id='abc'
test('GET /api/search?q= matches title and content with snippets', ...);
test('unknown route → 404', ...);
test('server binds 127.0.0.1 only', ...);         // assert server.address().address
test('SSE /events emits change after file write', ...); // write to fixture task file, expect event ≤2s
test('rescan after change: new file appears in tree, open doc re-resolvable by nodeKey+file', ...);
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**

```js
function createServer(opts = {}) {
  // state: { generation, docs, groups } from buildTree(opts)
  // const rescan = debounce(200ms) → buildTree + bump generation + broadcast SSE 'change'
  // fs.watch(watchDirs, {recursive:true}) → rescan   (wrap: watch may throw on missing dir)
  // routes (manual url.parse, no framework):
  //   GET /            → app.html (read once at startup, cache)
  //   GET /api/tree    → JSON state (docs metadata only, no content)
  //   GET /api/doc     → /^\d+$/ guard on id; fs.readFileSync(doc.path) at request
  //                      time → markdown.render(); 404 if gone
  //   GET /api/search  → q (min 2 chars); scan docs: title match + line matches,
  //                      ≤5 snippets/doc, ≤50 total
  //   GET /events      → SSE: headers, heartbeat 30s, client set, broadcast(JSON)
  //   else 404 JSON. Whole handler in try/catch → 500 JSON, never crash.
  // returns { server, listen(port,…→actualPort), close(), rescan }
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(web): planning viewer http server`

### Task 4: SPA client (`src/web/app.html`)

**Files:**
- Create: `src/web/app.html`
- Test: extend `test/web-server.test.js` (served-page markers)

- [ ] **Step 1: Failing test additions:** `/` response contains `id="atem-web-app"`, `#/doc/` router code, `EventSource('/events')`, `localStorage` collapse persistence, search input `id="search"`.
- [ ] **Step 2–3: Implement the SPA** (single file, vanilla JS, no external assets):
  - Hash router: `#/` dashboard (recent docs by mtime from `/api/tree`), `#/doc/<id>` document view; `hashchange` listener; invalid id → dashboard.
  - Sidebar: Tasks group (provider badge, seven files) + Projects group; collapsible nodes persisted to `localStorage('atem-web-collapsed')`; active doc highlighted.
  - Doc view: fetch `/api/doc?id=`; header with title/path/mtime; raw toggle (`<pre>` of `raw`); TOC sidebar when ≥3 headings (from rendered `h1–h3` ids); rewrite internal `.md` links: after render, for each `<a>` whose href resolves (relative to doc path) to another doc's path in the tree → `#/doc/<id>`; external links `target=_blank rel=noopener`.
  - Search: debounce 150ms → `/api/search`; results panel replaces tree; Enter/click navigates.
  - SSE: `EventSource('/events')`; on `change` → refetch tree; if open doc's `nodeKey+file` still exists, re-resolve its (possibly new) id and refetch content in place; else show "document removed" card.
  - Theme via `prefers-color-scheme`; readable measure (~72ch), code/table styling.
- [ ] **Step 4: Run server tests** — PASS. Manual check: `node bin/atem.js web --no-open`, open browser, verify dashboard/doc/search/reload.
- [ ] **Step 5: Commit** `feat(web): interactive SPA client`

### Task 5: CLI wiring (`atem web`)

**Files:**
- Modify: `src/cli.js` (add `case 'web'` in `main()` switch; add `commandWeb`; add usage line in `printUsage()`)
- Test: `test/web-cli.test.js`

- [ ] **Step 1: Failing test:**

```js
test('atem web serves tree over http', async () => {
  // temp HOME harness (makeTempHarness pattern); run(['init']); run(['start','T','--repo',tmp]);
  // spawn('node',[ATEM,'web','--no-open','--port','0'], {env}) ; read stdout for
  // /http:\/\/127\.0\.0\.1:(\d+)/ ; fetch `/api/tree` → 200, groups array; kill child.
});
test('help mentions web', () => assert.match(run(['--help']), /atem web/));
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement:**

```js
function commandWeb(gitRoot, args) {
  let port = 4400; let open = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--no-open') open = false;
    else throw new Error('Usage: atem web [--port <n>] [--no-open]');
  }
  const { createServer } = require('./web/server.js');
  const app = createServer({ cwdRepo: gitRoot });
  app.listen(port, (actualPort) => {
    const url = `http://127.0.0.1:${actualPort}`;
    console.log(`${ICONS.ok} ATEM planning viewer: ${url}`);
    if (open && process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  });
  // port-in-use: listen() retries port+1..port+20 before failing
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(cli): atem web command`

### Task 6: Docs + full suite

- [ ] README: add `atem web` to the command list/quickstart. CHANGELOG entry under Unreleased.
- [ ] Run **full** suite: `node --test` — all pass (no regressions).
- [ ] Commit `docs: atem web in README/CHANGELOG`.

---

## Testing notes for the executor

- Follow the existing harness pattern (`makeTempHarness` in `test/adapter.test.js`): temp `HOME`, `ATEM_HARNESS_MODE=global`, run CLI via `execFileSync('node', [bin/atem.js, ...])`.
- For scan/server tests prefer direct module calls with explicit `opts` roots over env vars where possible; env overrides exist for the CLI-level test.
- SSE test: use `fetch` + `res.body.getReader()`; allow generous (2s) timeouts; always `close()` servers in `t.after`.
- Never touch the real `~/.atem`, `~/.claude`, `~/.codex` in tests.

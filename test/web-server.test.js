const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../src/web/server.js');
const { TASK_FILES } = require('../src/web/scan.js');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-web-srv-'));
  const proj = path.join(root, 'projects', 'alpha');
  const handles = path.join(root, 'handles');
  const dir = path.join(handles, 'TASK-001');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of TASK_FILES) {
    const fm = f === 'state' ? `status: active\nrepo: ${proj}` : 'status: active';
    fs.writeFileSync(path.join(dir, `${f}.md`), `---\n${fm}\n---\n# ${f} heading\n\nbody of ${f} searchterm-${f}\n`);
  }
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), '# Alpha Roadmap\n\nunique-roadmap-term\n');
  return { root, handles, proj };
}

// The single project node and its nested task child, for the fixture above.
function alphaNode(tree) {
  return tree.groups.find((g) => g.kind === 'projects').nodes[0];
}
function alphaTask(tree) {
  return (alphaNode(tree).children || []).find((c) => c.kind === 'task');
}

async function startApp(fx, extra = {}) {
  const app = createServer({
    handlesDir: fx.handles,
    claudeProjectsDir: path.join(fx.root, 'no-claude'),
    codexSessionsDir: path.join(fx.root, 'no-codex'),
    extraRoots: [fx.proj],
    configPath: path.join(fx.root, 'web-config.json'),
    ...extra,
  });
  const port = await new Promise((resolve) => app.listen(0, resolve));
  return { app, base: `http://127.0.0.1:${port}` };
}

test('GET / serves the SPA shell', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /atem-web-app/);
});

test('SPA shell contains router, SSE, search, and persistence wiring', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /#\/doc\//, 'hash router');
  assert.match(html, /EventSource\(['"]\/events['"]\)/, 'live reload');
  assert.match(html, /localStorage/, 'collapse persistence');
  assert.match(html, /id="search"/, 'search input');
  assert.match(html, /prefers-color-scheme/, 'theme support');
  assert.match(html, /id="settings"/, 'settings panel');
  assert.match(html, /\/api\/config/, 'config wiring');
  assert.match(html, /enhanceCodeBlocks/, 'collapsible code');
  assert.match(html, /enhanceHeadings/, 'foldable sections');
});

test('GET /api/tree returns groups + generation', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const tree = await (await fetch(base + '/api/tree')).json();
  assert.ok(typeof tree.generation === 'number');
  assert.equal(tree.groups.length, 1);
  assert.equal(tree.groups[0].kind, 'projects');
  assert.equal(alphaNode(tree).label, 'alpha');
  assert.equal(alphaTask(tree).label, 'TASK-001'); // task nested under its project
});

test('GET /api/doc returns rendered html, raw, frontmatter, path, mtime', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const tree = await (await fetch(base + '/api/tree')).json();
  const id = alphaTask(tree).docs[0];
  const doc = await (await fetch(`${base}/api/doc?id=${id}`)).json();
  assert.match(doc.html, /<h1 id="[^"]*">.*heading<\/h1>/);
  assert.match(doc.raw, /# brief heading/);
  assert.equal(doc.frontmatter.status, 'active');
  assert.ok(doc.path.endsWith('brief.md'));
  assert.ok(doc.mtime > 0);
  assert.ok(doc.key);
  assert.ok(doc.file);
});

test('bad doc ids yield 404 JSON, including traversal attempts', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  for (const id of ['999', 'abc', '../../etc/passwd', '-1', '0.5']) {
    const res = await fetch(`${base}/api/doc?id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 404, `id=${id}`);
    assert.match(res.headers.get('content-type'), /application\/json/);
  }
});

test('GET /api/search matches content with snippets', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const out = await (await fetch(`${base}/api/search?q=unique-roadmap-term`)).json();
  assert.equal(out.results.length, 1);
  assert.match(out.results[0].snippet, /unique-roadmap-term/);
  assert.equal(typeof out.results[0].id, 'number');
  // short queries rejected politely
  const short = await (await fetch(`${base}/api/search?q=a`)).json();
  assert.deepEqual(short.results, []);
});

test('config round-trips: GET defaults, POST persists, GET reflects', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const initial = await (await fetch(base + '/api/config')).json();
  assert.equal(initial.showExecuted, true);
  assert.deepEqual(initial.hideFolders, []);

  const posted = await (await fetch(base + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ showExecuted: false, hideFolders: 'research, archive', junk: 'x' }),
  })).json();
  assert.equal(posted.showExecuted, false);
  assert.deepEqual(posted.hideFolders, ['research', 'archive']);
  assert.equal('junk' in posted, false);

  const after = await (await fetch(base + '/api/config')).json();
  assert.equal(after.showExecuted, false);
  assert.deepEqual(after.hideFolders, ['research', 'archive']);
});

test('POST /api/config with invalid JSON → 400', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const res = await fetch(base + '/api/config', { method: 'POST', body: 'not json' });
  assert.equal(res.status, 400);
});

test('unknown routes 404', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});

test('server binds 127.0.0.1 only', async (t) => {
  const fx = makeFixture();
  const { app } = await startApp(fx);
  t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
});

async function readSseEvent(base, trigger, timeoutMs = 3000) {
  const res = await fetch(`${base}/events`);
  const reader = res.body.getReader();
  await trigger();
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: null, done: false }), deadline - Date.now())),
    ]);
    if (done) break;
    if (value) buf += Buffer.from(value).toString('utf8');
    if (buf.includes('data:') && buf.includes('change')) break;
  }
  reader.cancel().catch(() => {});
  return buf;
}

test('SSE emits change when a task file changes', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const buf = await readSseEvent(base, async () => {
    await new Promise((r) => setTimeout(r, 100));
    fs.appendFileSync(path.join(fx.handles, 'TASK-001', 'log.md'), '\nnew line\n');
  });
  assert.match(buf, /change/);
});

test('SSE emits change when a PROJECT planning doc changes', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const buf = await readSseEvent(base, async () => {
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(fx.proj, '.planning', 'NEW-PLAN.md'), '# New Plan\n');
  });
  assert.match(buf, /change/);
});

test('rescan picks up new files; docs re-resolvable by nodeKey+file', async (t) => {
  const fx = makeFixture();
  const { app, base } = await startApp(fx);
  t.after(() => app.close());
  const before = await (await fetch(base + '/api/tree')).json();
  fs.writeFileSync(path.join(fx.proj, '.planning', 'EXTRA.md'), '# Extra\n');
  app.rescan();
  const after = await (await fetch(base + '/api/tree')).json();
  assert.ok(after.generation > before.generation);
  const node = after.groups[0].nodes.find((n) => n.key === `project:${fs.realpathSync(fx.proj)}`);
  const extra = node.docs.map((i) => after.docs[i]).find((d) => d.file === '.planning/EXTRA.md');
  assert.ok(extra, 'new doc present after rescan');
});

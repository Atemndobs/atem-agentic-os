const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildTree, decodeClaudeProjectDir, scanProjectDocs, TASK_FILES } = require('../src/web/scan.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFixture() {
  const root = tmpdir('atem-web-scan-');
  // ATEM handles: two tasks + _archive + current symlink
  const proj = path.join(root, 'projects', 'alpha');
  const handles = path.join(root, 'handles');
  for (const task of ['TASK-001', 'claude-code:abc123']) {
    const dir = path.join(handles, task);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of TASK_FILES) {
      const body = f === 'state' ? `---\nrepo: ${proj}\n---\n# ${f} of ${task}\n` : `# ${f} of ${task}\n`;
      fs.writeFileSync(path.join(dir, `${f}.md`), body);
    }
  }
  fs.mkdirSync(path.join(handles, '_archive', 'TASK-OLD'), { recursive: true });
  fs.symlinkSync(path.join(handles, 'TASK-001'), path.join(handles, 'current'));

  // A project with planning docs (the tasks above target it)
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(proj, '.planning', 'research'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'docs', 'sub-plans'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), '# Alpha Roadmap\n');
  fs.writeFileSync(path.join(proj, '.planning', 'research', 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(proj, 'docs', 'sub-plans', 'sub-plan-1.md'), '# Sub 1\n');
  fs.writeFileSync(path.join(proj, 'PLAN.md'), '# Alpha Plan\n');
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Agents\n');
  // superpowers brainstorming/writing-plans output
  fs.mkdirSync(path.join(proj, 'docs', 'superpowers', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'superpowers', 'specs', '2026-01-01-feature-design.md'), '# Feature Design\n');
  fs.writeFileSync(path.join(proj, 'docs', 'superpowers', 'plans', '2026-01-01-feature.md'), '# Feature Plan\n');
  // plain docs/ files outside any "planning" subdir — must still appear
  fs.writeFileSync(path.join(proj, 'docs', 'guide.md'), '# Guide\n');
  fs.mkdirSync(path.join(proj, 'docs', 'architecture'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'architecture', 'overview.md'), '# Overview\n');

  // A project with NO planning docs (must be omitted)
  const bare = path.join(root, 'projects', 'bare');
  fs.mkdirSync(bare, { recursive: true });

  // Claude projects registry pointing at proj (encoded path)
  const claudeProjects = path.join(root, 'claude-projects');
  fs.mkdirSync(path.join(claudeProjects, proj.replace(/\//g, '-')), { recursive: true });

  // Codex sessions with a session_meta cwd pointing at bare (and a bogus file)
  const codexSessions = path.join(root, 'codex-sessions', '2026', '06', '13');
  fs.mkdirSync(codexSessions, { recursive: true });
  fs.writeFileSync(
    path.join(codexSessions, 'rollout-1.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { cwd: bare } }) + '\n{"type":"other"}\n'
  );
  fs.writeFileSync(path.join(codexSessions, 'broken.jsonl'), 'not json\n');

  return { root, handles, proj, bare, claudeProjects, codexSessions: path.join(root, 'codex-sessions') };
}

function opts(fx, extra = {}) {
  return {
    handlesDir: fx.handles,
    claudeProjectsDir: fx.claudeProjects,
    codexSessionsDir: fx.codexSessions,
    extraRoots: [],
    ...extra,
  };
}

test('decodeClaudeProjectDir resolves dashes via directory listings', () => {
  const dirs = {
    '/': ['Users', 'private'],
    '/Users': ['x'],
    '/Users/x': ['my-app', 'my'],
    '/Users/x/my-app': ['.claude'],
    '/Users/x/my': ['app'],
    '/Users/x/my-app/.claude': ['worktrees'],
    '/Users/x/my-app/.claude/worktrees': ['wt-1'],
  };
  const listDir = (p) => dirs[p] || null;
  assert.equal(decodeClaudeProjectDir('-Users-x-my-app', listDir), '/Users/x/my-app');
  // '--' encodes '/.': old-style dot-dir encoding
  assert.equal(
    decodeClaudeProjectDir('-Users-x-my-app--claude-worktrees-wt-1', listDir),
    '/Users/x/my-app/.claude/worktrees/wt-1'
  );
  // ambiguity: '/Users/x/my/app' also exists; either reading is acceptable,
  // but a result must be returned and must be a real path
  const ambiguous = decodeClaudeProjectDir('-Users-x-my-app', listDir);
  assert.ok(['/Users/x/my-app', '/Users/x/my/app'].includes(ambiguous));
  assert.equal(decodeClaudeProjectDir('-No-such-path', listDir), null);
  assert.equal(decodeClaudeProjectDir('not-encoded', listDir), null);
});

test('decodeClaudeProjectDir is fast on undecodable many-dash names', () => {
  const listDir = (p) => (p === '/' ? ['nothing'] : null);
  const start = Date.now();
  const name = '-a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z';
  assert.equal(decodeClaudeProjectDir(name, listDir), null);
  assert.ok(Date.now() - start < 100, 'must fail fast, not explore 3^n states');
});

function alphaTasks(fx) {
  const { groups } = buildTree(opts(fx, { extraRoots: [fx.proj] }));
  const proj = groups.find((g) => g.kind === 'projects').nodes
    .find((n) => n.root === fs.realpathSync(fx.proj));
  return (proj.children || []).filter((c) => c.kind === 'task');
}

test('tasks nest under their project; no standalone Tasks group; _archive/current excluded', () => {
  const fx = makeFixture();
  const { groups } = buildTree(opts(fx, { extraRoots: [fx.proj] }));
  assert.equal(groups.some((g) => g.kind === 'tasks'), false);
  const names = alphaTasks(fx).map((n) => n.label);
  assert.ok(names.includes('TASK-001'));
  assert.ok(names.includes('claude-code:abc123'));
  assert.ok(!names.some((n) => n.includes('_archive') || n === 'current' || n.includes('TASK-OLD')));
});

test('task docs are the seven canonical files in stable order', () => {
  const fx = makeFixture();
  const { docs } = buildTree(opts(fx, { extraRoots: [fx.proj] }));
  const node = alphaTasks(fx).find((n) => n.label === 'TASK-001');
  const files = node.docs.map((id) => docs[id].file);
  assert.deepEqual(files, TASK_FILES.map((f) => `${f}.md`));
});

test('provider derived from handle prefix; bare TASK ids have provider null', () => {
  const fx = makeFixture();
  const tasks = alphaTasks(fx);
  assert.equal(tasks.find((n) => n.label === 'claude-code:abc123').provider, 'claude-code');
  assert.equal(tasks.find((n) => n.label === 'TASK-001').provider, null);
});

test('project scan shows all of docs/ and .planning/ plus root entry files', () => {
  const fx = makeFixture();
  const found = scanProjectDocs(fx.proj).map((d) => d.rel).sort();
  assert.deepEqual(found, [
    '.planning/ROADMAP.md',
    '.planning/research/notes.md',
    'AGENTS.md',
    'PLAN.md',
    'docs/architecture/overview.md',
    'docs/guide.md',
    'docs/sub-plans/sub-plan-1.md',
    'docs/superpowers/specs/2026-01-01-feature-design.md',
    'docs/superpowers/plans/2026-01-01-feature.md',
  ].sort());
});

test('hand-off tasks nest under their project; no standalone Tasks group; orphans dropped', () => {
  const root = tmpdir('atem-web-tasknest-');
  const repo = path.join(root, 'myrepo');
  fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.planning', 'ROADMAP.md'), '# Roadmap\n');

  const handles = path.join(root, 'handles');
  const mkTask = (id, repoLine) => {
    const dir = path.join(handles, id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of TASK_FILES) {
      const body = f === 'state'
        ? `---\ntask_id: ${id}\n${repoLine}\n---\n# State\n`
        : `# ${f}\n`;
      fs.writeFileSync(path.join(dir, `${f}.md`), body);
    }
  };
  mkTask('claude-code:abc', `repo: ${repo}`);
  mkTask('TASK-orphan', 'repo: unknown');

  const tree = buildTree({
    handlesDir: handles,
    claudeProjectsDir: path.join(root, 'no-claude'),
    codexSessionsDir: path.join(root, 'no-codex'),
    extraRoots: [repo],
  });

  // no standalone tasks group
  assert.equal(tree.groups.some((g) => g.kind === 'tasks'), false);
  const projects = tree.groups.find((g) => g.kind === 'projects');
  const repoNode = projects.nodes.find((n) => n.root === fs.realpathSync(repo));
  assert.ok(repoNode, 'project node exists');

  // the task nests under the project as a kind:task child
  const taskChild = (repoNode.children || []).find((c) => c.kind === 'task');
  assert.ok(taskChild, 'task nested under project');
  assert.equal(taskChild.key, 'task:claude-code:abc');
  assert.equal(taskChild.provider, 'claude-code');
  assert.equal(taskChild.docs.length, TASK_FILES.length);

  // orphan task (repo: unknown) is not shown anywhere
  const everyKey = [];
  const walk = (nodes) => nodes.forEach((n) => { everyKey.push(n.key); if (n.children) walk(n.children); });
  walk(projects.nodes);
  assert.ok(!everyKey.some((k) => k.includes('TASK-orphan')), 'orphan task dropped');
});

test('worktrees nest under their parent repo, each carrying its own docs', () => {
  const root = tmpdir('atem-web-wt-');
  const repo = path.join(root, 'myrepo');
  fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.planning', 'ROADMAP.md'), '# Repo Roadmap\n');
  // a Claude Code worktree with its own branch-specific plan
  const wt = path.join(repo, '.claude', 'worktrees', 'feature-x');
  fs.mkdirSync(path.join(wt, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'docs', 'superpowers', 'plans', 'p.md'), '# Branch Plan\n');

  const tree = buildTree({
    handlesDir: path.join(root, 'no-handles'),
    claudeProjectsDir: path.join(root, 'no-claude'),
    codexSessionsDir: path.join(root, 'no-codex'),
    extraRoots: [repo, wt],
  });
  const projects = tree.groups.find((g) => g.kind === 'projects');
  // exactly one top-level project node (the repo) — worktree is NOT top-level
  assert.equal(projects.nodes.length, 1);
  const repoNode = projects.nodes[0];
  assert.equal(repoNode.kind, 'repo');
  assert.equal(repoNode.label, 'myrepo');
  assert.equal(repoNode.root, fs.realpathSync(repo));
  assert.deepEqual(repoNode.docs.map((i) => tree.docs[i].file), ['.planning/ROADMAP.md']);
  // worktree nested as a child, with its own docs
  assert.equal(repoNode.children.length, 1);
  const child = repoNode.children[0];
  assert.equal(child.kind, 'worktree');
  assert.equal(child.label, 'feature-x');
  assert.equal(child.root, fs.realpathSync(wt));
  assert.deepEqual(child.docs.map((i) => tree.docs[i].file), ['docs/superpowers/plans/p.md']);
  assert.ok(!projects.nodes.some((n) => n.root === fs.realpathSync(wt)), 'worktree not top-level');
});

test('a parent repo appears once even when only its worktrees were discovered', () => {
  const root = tmpdir('atem-web-wt2-');
  const repo = path.join(root, 'solo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\n'); // repo has a doc but was not "visited"
  const wt = path.join(repo, '.claude', 'worktrees', 'wt1');
  fs.mkdirSync(path.join(wt, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.planning', 'PLAN.md'), '# WT Plan\n');

  const tree = buildTree({
    handlesDir: path.join(root, 'no-handles'),
    claudeProjectsDir: path.join(root, 'no-claude'),
    codexSessionsDir: path.join(root, 'no-codex'),
    extraRoots: [wt], // only the worktree was discovered
  });
  const projects = tree.groups.find((g) => g.kind === 'projects');
  assert.equal(projects.nodes.length, 1);
  assert.equal(projects.nodes[0].label, 'solo');
  assert.equal(projects.nodes[0].children.length, 1);
  assert.equal(projects.nodes[0].children[0].label, 'wt1');
});

function statusOpts(root, extra = {}) {
  return {
    handlesDir: path.join(root, 'no-handles'),
    claudeProjectsDir: path.join(root, 'no-claude'),
    codexSessionsDir: path.join(root, 'no-codex'),
    ...extra,
  };
}

test('plan status: main role doc is blue, newest plan green, older plans orange', () => {
  const root = tmpdir('atem-web-status-');
  const repo = path.join(root, 'proj');
  fs.mkdirSync(path.join(repo, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'research'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'action-plan.md'), '# Action Plan\n');
  const older = path.join(repo, 'docs', 'superpowers', 'plans', 'old-plan.md');
  const newer = path.join(repo, 'docs', 'superpowers', 'plans', 'new-plan.md');
  fs.writeFileSync(older, '# Old\n');
  fs.writeFileSync(newer, '# New\n');
  const now = Date.now();
  fs.utimesSync(older, new Date(now - 100000), new Date(now - 100000));
  fs.utimesSync(newer, new Date(now), new Date(now));
  fs.writeFileSync(path.join(repo, 'docs', 'research', 'notes.md'), '# Notes\n');

  const tree = buildTree(statusOpts(root, { extraRoots: [repo] }));
  const node = tree.groups.find((g) => g.kind === 'projects').nodes[0];
  const byFile = {};
  for (const id of node.docs) byFile[tree.docs[id].file] = tree.docs[id].status;
  assert.equal(byFile['docs/action-plan.md'], 'main');
  assert.equal(byFile['docs/superpowers/plans/new-plan.md'], 'active');
  assert.equal(byFile['docs/superpowers/plans/old-plan.md'], 'done');
  assert.equal(byFile['docs/research/notes.md'], null);
});

test('frontmatter status overrides recency (newest marked complete is not active)', () => {
  const root = tmpdir('atem-web-status2-');
  const repo = path.join(root, 'proj');
  fs.mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
  const done = path.join(repo, 'docs', 'plans', 'shipped-plan.md');
  const wip = path.join(repo, 'docs', 'plans', 'wip-plan.md');
  fs.writeFileSync(done, '---\nstatus: complete\n---\n# Shipped\n');
  fs.writeFileSync(wip, '# WIP\n');
  const now = Date.now();
  fs.utimesSync(done, new Date(now), new Date(now));           // newest
  fs.utimesSync(wip, new Date(now - 50000), new Date(now - 50000));

  const tree = buildTree(statusOpts(root, { extraRoots: [repo] }));
  const node = tree.groups.find((g) => g.kind === 'projects').nodes[0];
  const byFile = {};
  for (const id of node.docs) byFile[tree.docs[id].file] = tree.docs[id].status;
  assert.equal(byFile['docs/plans/shipped-plan.md'], 'done');  // explicit override wins
  assert.equal(byFile['docs/plans/wip-plan.md'], 'active');    // newest without override
});

test('Claude project memory plans attach under a ‹claude memory› folder', () => {
  const root = tmpdir('atem-web-mem-');
  const repo = path.join(root, 'proj');
  fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.planning', 'ROADMAP.md'), '# RM\n');
  // claude-projects registry entry decoding to repo, with a memory dir
  const claudeProjects = path.join(root, 'claude-projects');
  const encoded = path.join(claudeProjects, repo.replace(/\//g, '-'), 'memory');
  fs.mkdirSync(encoded, { recursive: true });
  fs.writeFileSync(path.join(encoded, 'project_x_plan.md'), '# Hidden Plan\n');
  fs.writeFileSync(path.join(encoded, 'user_role.md'), '# Role\n');

  const tree = buildTree(statusOpts(root, { claudeProjectsDir: claudeProjects, extraRoots: [repo] }));
  const node = tree.groups.find((g) => g.kind === 'projects').nodes[0];
  const files = node.docs.map((i) => tree.docs[i].file);
  assert.ok(files.includes('‹claude memory›/project_x_plan.md'), `got ${files}`);
  assert.ok(files.includes('‹claude memory›/user_role.md'));
  // the memory doc resolves to the real hidden path
  const memDoc = node.docs.map((i) => tree.docs[i]).find((d) => d.file === '‹claude memory›/project_x_plan.md');
  assert.ok(memDoc.path.includes('/memory/project_x_plan.md'));
});

test('doc-site projects show only planning-shaped docs/ files, not the whole site', () => {
  const root = tmpdir('atem-web-docsite-');
  const proj = path.join(root, 'beta');
  fs.mkdirSync(path.join(proj, 'docs', 'reference'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'docs', 'zh-CN'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'docs', 'research'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'docs.json'), '{}'); // Mintlify doc-site marker
  fs.writeFileSync(path.join(proj, 'docs', 'index.md'), '# Home\n');             // excluded
  fs.writeFileSync(path.join(proj, 'docs', 'reference', 'api.md'), '# API\n');   // excluded
  fs.writeFileSync(path.join(proj, 'docs', 'zh-CN', 'index.md'), '# Home zh\n'); // excluded
  fs.writeFileSync(path.join(proj, 'docs', 'superpowers', 'plans', 'p.md'), '# Plan\n'); // included
  fs.writeFileSync(path.join(proj, 'docs', 'research', 'r.md'), '# Research\n');          // included
  fs.writeFileSync(path.join(proj, '.planning', 'ROADMAP.md'), '# RM\n');                 // included
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Agents\n');                           // included
  const found = scanProjectDocs(proj).map((d) => d.rel).sort();
  assert.deepEqual(found, [
    '.planning/ROADMAP.md',
    'AGENTS.md',
    'docs/research/r.md',
    'docs/superpowers/plans/p.md',
  ].sort());
});

test('mkdocs.yml at repo root also marks a doc-site', () => {
  const root = tmpdir('atem-web-mkdocs-');
  const proj = path.join(root, 'gamma');
  fs.mkdirSync(path.join(proj, 'docs', 'guide'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'mkdocs.yml'), 'site_name: x\n');
  fs.writeFileSync(path.join(proj, 'docs', 'guide', 'page.md'), '# Page\n'); // excluded
  fs.writeFileSync(path.join(proj, 'docs', 'action-plan.md'), '# Plan\n');   // included (named)
  const found = scanProjectDocs(proj).map((d) => d.rel).sort();
  assert.deepEqual(found, ['docs/action-plan.md']);
});

test('projects discovered via claude registry and codex sessions; no-doc projects omitted', () => {
  const fx = makeFixture();
  const { groups } = buildTree(opts(fx));
  const projects = groups.find((g) => g.kind === 'projects');
  const roots = projects.nodes.map((n) => n.root);
  assert.ok(roots.includes(fs.realpathSync(fx.proj)), `expected ${fx.proj} in ${roots}`);
  // bare has no planning docs → omitted even though codex references it
  assert.ok(!roots.includes(fs.realpathSync(fx.bare)));
});

test('tmp roots and missing paths are skipped, extraRoots included, dedupe via realpath', () => {
  const fx = makeFixture();
  const { groups } = buildTree(opts(fx, { extraRoots: [fx.proj, fx.proj, '/tmp/somewhere', path.join(fx.root, 'gone')] }));
  const projects = groups.find((g) => g.kind === 'projects');
  const count = projects.nodes.filter((n) => n.root === fs.realpathSync(fx.proj)).length;
  assert.equal(count, 1);
  assert.ok(!projects.nodes.some((n) => n.root.startsWith('/tmp/somewhere')));
});

test('doc ids are sequential, unique, and match docs array indexes', () => {
  const fx = makeFixture();
  const { docs, groups } = buildTree(opts(fx));
  docs.forEach((d, i) => assert.equal(d.id, i));
  const all = groups.flatMap((g) => g.nodes.flatMap((n) => n.docs));
  assert.equal(new Set(all).size, all.length);
});

test('docs carry title from first heading and mtime', () => {
  const fx = makeFixture();
  const { docs } = buildTree(opts(fx));
  const roadmap = docs.find((d) => d.file === '.planning/ROADMAP.md');
  assert.equal(roadmap.title, 'Alpha Roadmap');
  assert.ok(roadmap.mtime > 0);
});

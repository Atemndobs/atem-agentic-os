// Local HTTP server for the planning viewer. Localhost only; clients
// reference documents by opaque id, so no client-supplied path ever
// touches the filesystem. The whole request handler is wrapped so a
// malformed request can never take the server down.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');

const { buildTree } = require('./scan.js');
const markdown = require('./markdown.js');

const APP_HTML = fs.readFileSync(path.join(__dirname, 'app.html'));

const DEBOUNCE_MS = 200;
const SEARCH_MAX_TOTAL = 50;
const SEARCH_MAX_PER_DOC = 5;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function createServer(opts = {}) {
  let state = { generation: 0, docs: [], groups: [] };
  const sseClients = new Set();
  let watchers = [];
  let debounceTimer = null;

  function broadcast(event) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) res.write(payload);
  }

  function treeOpts() {
    return {
      handlesDir: opts.handlesDir,
      claudeProjectsDir: opts.claudeProjectsDir,
      codexSessionsDir: opts.codexSessionsDir,
      extraRoots: [...(opts.extraRoots || []), opts.cwdRepo].filter(Boolean),
    };
  }

  function watchDirs() {
    const dirs = new Set();
    const sessions = opts.watchDir
      || process.env.ATEM_WEB_WATCH_DIR
      || path.join(os.homedir(), '.atem', 'harness', 'sessions');
    dirs.add(sessions);
    if (opts.handlesDir) dirs.add(opts.handlesDir);
    for (const node of (state.groups.find((g) => g.kind === 'projects') || { nodes: [] }).nodes) {
      dirs.add(path.join(node.root, '.planning'));
      dirs.add(path.join(node.root, 'docs'));
      dirs.add(node.root); // non-recursive intent: PLAN.md / AGENTS.md edits
    }
    return [...dirs];
  }

  function resetWatchers() {
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
    watchers = [];
    for (const dir of watchDirs()) {
      try {
        const recursive = dir !== path.dirname(dir); // always true; recursive ok on darwin
        const w = fs.watch(dir, { recursive }, () => scheduleRescan());
        watchers.push(w);
      } catch { /* dir missing — fine */ }
    }
  }

  function rescan() {
    state = { generation: state.generation + 1, ...buildTree(treeOpts()) };
    resetWatchers();
    broadcast({ type: 'change', generation: state.generation });
  }

  function scheduleRescan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(rescan, DEBOUNCE_MS);
  }

  function handleDoc(query, res) {
    const idStr = query.get('id') || '';
    if (!/^\d+$/.test(idStr)) return json(res, 404, { error: 'unknown doc' });
    const doc = state.docs[Number(idStr)];
    if (!doc) return json(res, 404, { error: 'unknown doc' });
    let raw;
    try { raw = fs.readFileSync(doc.path, 'utf8'); } catch {
      return json(res, 404, { error: 'document no longer exists', id: doc.id });
    }
    const { html, frontmatter } = markdown.render(raw);
    return json(res, 200, {
      id: doc.id, key: doc.nodeKey, file: doc.file, title: doc.title,
      path: doc.path, mtime: doc.mtime, group: doc.group, html, raw, frontmatter,
    });
  }

  function handleSearch(query, res) {
    const q = (query.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return json(res, 200, { results: [] });
    const results = [];
    for (const doc of state.docs) {
      if (results.length >= SEARCH_MAX_TOTAL) break;
      let content = '';
      try { content = fs.readFileSync(doc.path, 'utf8'); } catch { continue; }
      let perDoc = 0;
      if (doc.title.toLowerCase().includes(q)) {
        results.push({ id: doc.id, title: doc.title, file: doc.file, nodeKey: doc.nodeKey, line: 0, snippet: doc.title });
        perDoc++;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && perDoc < SEARCH_MAX_PER_DOC && results.length < SEARCH_MAX_TOTAL; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({ id: doc.id, title: doc.title, file: doc.file, nodeKey: doc.nodeKey, line: i + 1, snippet: lines[i].trim().slice(0, 200) });
          perDoc++;
        }
      }
    }
    return json(res, 200, { results });
  }

  function handleEvents(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', generation: state.generation })}\n\n`);
    sseClients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 30000);
    res.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      switch (url.pathname) {
        case '/':
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(APP_HTML);
        case '/api/tree':
          return json(res, 200, state);
        case '/api/doc':
          return handleDoc(url.searchParams, res);
        case '/api/search':
          return handleSearch(url.searchParams, res);
        case '/events':
          return handleEvents(res);
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      try { json(res, 500, { error: String(e && e.message || e) }); } catch { /* socket gone */ }
    }
  });

  function listen(port, cb, attempt = 0) {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && port !== 0 && attempt < 20) {
        console.log(`port ${port} in use, trying ${port + 1}`);
        listen(port + 1, cb, attempt + 1);
      } else {
        throw e;
      }
    });
    server.listen(port, '127.0.0.1', () => {
      state = { generation: 1, ...buildTree(treeOpts()) };
      resetWatchers();
      if (cb) cb(server.address().port);
    });
  }

  function close() {
    clearTimeout(debounceTimer);
    for (const w of watchers) { try { w.close(); } catch { /* noop */ } }
    for (const res of sseClients) { try { res.end(); } catch { /* noop */ } }
    sseClients.clear();
    server.close();
  }

  return { server, listen, close, rescan };
}

module.exports = { createServer };

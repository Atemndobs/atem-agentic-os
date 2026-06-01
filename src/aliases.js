// Human-friendly aliases for synthetic task ids.
// Stored as JSON at `<harness>/sessions/.aliases.json` so the file
// travels with the rest of the session data and `atem clean` /
// `atem archive` can find it.
//
//   { "fix-oauth": "omp:01HGY4Z2-abc",
//     "TASK-001":  "claude-code:sess-789" }

const fs = require('node:fs');
const path = require('node:path');

function aliasesPath(paths) {
  return path.join(paths.harnessDir, 'sessions', '.aliases.json');
}

function readAliases(paths) {
  const file = aliasesPath(paths);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeAliases(paths, table) {
  const file = aliasesPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(table, null, 2) + '\n');
}

function setAlias(paths, alias, target) {
  if (!alias || !target) throw new Error('alias and target required');
  if (alias.includes('/') || alias.includes('\\') || alias.includes(':')) {
    throw new Error(`alias must not contain '/', '\\\\', or ':': ${alias}`);
  }
  const table = readAliases(paths);
  table[alias] = target;
  writeAliases(paths, table);
}

function removeAlias(paths, alias) {
  const table = readAliases(paths);
  if (!(alias in table)) return false;
  delete table[alias];
  writeAliases(paths, table);
  return true;
}

function resolveAlias(paths, alias) {
  const table = readAliases(paths);
  return table[alias] || null;
}

function findAliasFor(paths, target) {
  // Reverse lookup: which alias points at this synthetic id?
  const table = readAliases(paths);
  for (const [k, v] of Object.entries(table)) {
    if (v === target) return k;
  }
  return null;
}

module.exports = {
  aliasesPath,
  readAliases,
  writeAliases,
  setAlias,
  removeAlias,
  resolveAlias,
  findAliasFor,
};

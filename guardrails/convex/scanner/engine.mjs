/**
 * The AST walk that rules see.
 *
 * The checker this replaces used regexes and missed 72% of query calls until
 * multi-line shapes were handled by hand. Convex's own ESLint plugin finds 22
 * `.filter()` violations in Ops Central where that regex finds 11. Both are
 * measurements, not opinions about parsing.
 *
 * `typescript` is resolved from the HOST repository rather than bundled. Every
 * Convex repository has it, the vendored scanner is meant to install nothing,
 * and the Harness itself keeps its zero-dependency runtime.
 */

import { createRequire } from "node:module";
import path from "node:path";

/** Load the host repository's TypeScript, with an error worth reading. */
export function loadTypeScript(repoRoot) {
  const require = createRequire(path.join(repoRoot, "package.json"));
  try {
    return require("typescript");
  } catch {
    throw new Error(
      `Convex Guard needs TypeScript, and none was found in ${repoRoot}. ` +
        `It resolves the repository's own copy rather than bundling one. ` +
        `Run \`npm install\` there first.`,
    );
  }
}

/** Look past `await`, parens and assertions to the node that uses a result. */
function unwrap(ts, node) {
  let n = node.parent;
  while (
    n &&
    (ts.isAwaitExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isAsExpression(n))
  ) {
    n = n.parent;
  }
  return n;
}

/** The nearest enclosing function body, for a local search. */
function enclosingBody(ts, node) {
  let n = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return n.body ?? null;
    }
    n = n.parent;
  }
  return null;
}

/**
 * What is done with a chain's result, whether or not it is named first.
 *
 * `(await q.collect()).length` and
 *
 *   const rows = await q.collect();
 *   return rows.length;
 *
 * are the same read and the same mistake. Only seeing the first is how
 * scan-to-count reported zero findings against a codebase of 361 files: the
 * two-step form is how people actually write it.
 *
 * The search is deliberately local. It follows one assignment inside one
 * function body, which is where this shape lives. It does not chase a variable
 * across functions or through a return, and a rule reading this should not
 * assume it does.
 */
function resultUses(ts, chainNode) {
  const uses = new Set();

  const direct = unwrap(ts, chainNode);
  if (direct && ts.isPropertyAccessExpression(direct)) {
    uses.add(direct.name.text);
  }

  // Named first: `const rows = await <chain>;`
  if (direct && ts.isVariableDeclaration(direct) && direct.name && ts.isIdentifier(direct.name)) {
    const varName = direct.name.text;
    const body = enclosingBody(ts, chainNode);
    if (body) {
      const walk = (n) => {
        if (
          ts.isPropertyAccessExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === varName
        ) {
          uses.add(n.name.text);
        }
        ts.forEachChild(n, walk);
      };
      walk(body);
    }
  }

  return uses;
}

/**
 * One `ctx.db.query(...)` chain, flattened into the order a reader sees it.
 *
 * The AST nests a chain inside-out: `.take()` is the outermost node and
 * `.query()` the innermost. Rules ask questions like "is there a `.withIndex`
 * before the `.collect`", so the chain is flattened once here and every rule
 * reads the same shape.
 */
function flattenChain(ts, node) {
  const calls = [];
  let current = node;
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (!ts.isPropertyAccessExpression(callee)) break;
    calls.unshift({
      method: callee.name.text,
      args: current.arguments,
      node: current,
    });
    current = callee.expression;
  }
  return { calls, base: current };
}

/** Is this chain rooted at `ctx.db.query(...)` or `db.query(...)`? */
function isDbQuery(ts, base, calls) {
  if (calls.length === 0) return false;
  if (calls[0].method !== "query") return false;
  const text = base.getText();
  return text === "ctx.db" || text === "db" || text.endsWith(".db");
}

/** The exported function a node sits in, or "<module>". */
function enclosingScope(ts, node) {
  let n = node;
  let best = null;
  while (n) {
    if (ts.isVariableDeclaration(n) && n.name && ts.isIdentifier(n.name)) {
      best = best ?? n.name.text;
    }
    if (
      (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      best = best ?? n.name.text;
    }
    n = n.parent;
  }
  return best ?? "<module>";
}

/**
 * Walk one file and hand each rule the chains it might care about.
 *
 * A rule is `{ id, check(chain, context) }` and returns zero or more findings.
 * Rules never touch the AST root, so a rule cannot accidentally depend on
 * traversal order.
 */
export function scanSource({ ts, filePath, sourceText, rules, schema }) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const findings = [];
  const chains = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      // Only consider the OUTERMOST call of a chain, so one chain is visited
      // once rather than once per link.
      const parent = node.parent;
      const isInner =
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node;
      if (!isInner) {
        const { calls, base } = flattenChain(ts, node);
        if (isDbQuery(ts, base, calls)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          chains.push({
            calls,
            node,
            file: filePath,
            line: line + 1,
            scope: enclosingScope(ts, node),
            text: node.getText(sourceFile),
            methods: calls.map((c) => c.method),
            has: (m) => calls.some((c) => c.method === m),
            find: (m) => calls.find((c) => c.method === m),
            // What happens to the rows, named or not. See resultUses.
            uses: resultUses(ts, node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const chain of chains) {
    for (const rule of rules) {
      const hits = rule.check(chain, { ts, sourceFile, schema }) ?? [];
      for (const hit of hits) {
        findings.push({
          rule: rule.id,
          file: filePath,
          line: hit.line ?? chain.line,
          scope: chain.scope,
          chain: chain.text,
          message: hit.message,
        });
      }
    }
  }

  return findings;
}

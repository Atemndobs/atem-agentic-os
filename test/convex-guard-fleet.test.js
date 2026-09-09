/**
 * Fleet survey tests.
 *
 * Every case here is a mistake the first live run actually made. Writing them
 * from imagination would have produced none of them: the phantom repositories,
 * the inverted mirror ownership and the worktree-over-primary choice were all
 * invisible until it ran against a real machine.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FLEET = path.join(__dirname, "..", "guardrails", "convex", "fleet-audit");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleet-"));
}

/**
 * A directory that looks like a Convex backend.
 *
 * `scannable` installs a stub node_modules/typescript. Without it the survey
 * correctly reports the repository as unknown and never calls the scanner,
 * which is right in production and made the first version of the mirror-total
 * test assert against a scan that had not run.
 */
function backend(root, name, { files = 1, convexDep = "^1.45.0", body = null, scannable = false } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "convex", "_generated"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, dependencies: { convex: convexDep } }),
  );
  for (let i = 0; i < files; i += 1) {
    fs.writeFileSync(
      path.join(dir, "convex", `m${i}.ts`),
      body ?? `export const q${i} = 1;\n`,
    );
  }
  if (scannable) {
    const ts = path.join(dir, "node_modules", "typescript");
    fs.mkdirSync(ts, { recursive: true });
    fs.writeFileSync(
      path.join(ts, "package.json"),
      JSON.stringify({ name: "typescript", version: "5.9.3", main: "index.js" }),
    );
    fs.writeFileSync(path.join(ts, "index.js"), "module.exports = {};\n");
  }
  return dir;
}

test("a directory called convex is not a backend without evidence", async () => {
  const { findConvexDirs } = await import(path.join(FLEET, "fleet.mjs"));
  const root = tmp();
  // A skill folder, a client helper and a test fixture all contain convex/.
  for (const p of ["skills/thing", "lib", "tests"]) {
    fs.mkdirSync(path.join(root, p, "convex"), { recursive: true });
    fs.writeFileSync(path.join(root, p, "convex", "x.ts"), "export const a = 1;\n");
  }
  backend(root, "real-app");
  const found = findConvexDirs([root]).map((d) => path.basename(d));
  assert.deepEqual(found, ["real-app"]);
});

test("archived copies and the guardrails source are skipped", async () => {
  const { findConvexDirs } = await import(path.join(FLEET, "fleet.mjs"));
  const root = tmp();
  backend(root, "archive/old-app");
  backend(root, "guardrails/convex-thing");
  backend(root, "live-app");
  const found = findConvexDirs([root]).map((d) => path.basename(d));
  assert.deepEqual(found, ["live-app"]);
});

test("a nested app is named repo/app so two apps do not collide", async () => {
  const { inspectRepo } = await import(path.join(FLEET, "fleet.mjs"));
  const root = tmp();
  const dir = backend(root, "monorepo/apps/web");
  const info = inspectRepo(dir);
  // Without a git repo above it, the name is just the directory. The naming
  // only claims to distinguish apps INSIDE one repository.
  assert.ok(info.name.endsWith("web"));
  assert.equal(info.convex.files, 1);
});

test("a repository with no TypeScript is unknown, not clean", async () => {
  const { audit } = await import(path.join(FLEET, "audit.mjs"));
  const root = tmp();
  backend(root, "no-deps");
  const result = audit([root]);
  const row = result.repos.find((r) => r.name === "no-deps");
  assert.equal(row.status, "unknown");
  assert.ok(row.drift.some((d) => /cannot scan/.test(d)));
  // The distinction that matters: it contributes nothing to the total, and it
  // is not reported as zero findings.
  assert.equal(row.total, undefined);
});

test("a mirrored backend is reported but excluded from the fleet total", async () => {
  const { audit } = await import(path.join(FLEET, "audit.mjs"));
  const root = tmp();
  const shared = "export const q = 1;\n";
  backend(root, "owner", { files: 30, body: shared, scannable: true });
  backend(root, "copy", { files: 30, body: shared, scannable: true });
  const fake = () => [{ rule: "scan-to-count", file: "convex/m0.ts", scope: "q" }];
  const result = audit([root], { scan: fake });
  const mirrors = result.repos.filter((r) => r.mirrorOf);
  assert.equal(mirrors.length, 1, "one of the pair is the mirror");
  // Two repositories, one finding each, and a total of one.
  assert.equal(result.fleet.findings, 1);
  assert.equal(result.fleet.mirrors, 1);
});

test("the repository carrying the sync script is the copy, not the owner", async () => {
  const { surveyFleet } = await import(path.join(FLEET, "fleet.mjs"));
  const root = tmp();
  const shared = "export const q = 1;\n";
  const a = backend(root, "backend-owner", { files: 30, body: shared });
  const b = backend(root, "mobile-client", { files: 30, body: shared });
  // The client is the one that copies the backend in.
  const pkg = JSON.parse(fs.readFileSync(path.join(b, "package.json"), "utf8"));
  pkg.scripts = { "sync:convex-backend": "bash ./scripts/sync-convex-backend-from-admin.sh" };
  fs.writeFileSync(path.join(b, "package.json"), JSON.stringify(pkg));

  const repos = surveyFleet([root]);
  const client = repos.find((r) => r.name === "mobile-client");
  const owner = repos.find((r) => r.name === "backend-owner");
  assert.equal(client.mirrorOf, "backend-owner");
  assert.equal(owner.mirrorOf, null);
  assert.ok(a && b);
});

test("small repositories are never called mirrors of each other", async () => {
  // False-positive guard: two tiny backends that happen to share boilerplate
  // are not the same backend. Only trees of real size are compared.
  const { surveyFleet } = await import(path.join(FLEET, "fleet.mjs"));
  const root = tmp();
  const shared = "export const q = 1;\n";
  backend(root, "tiny-a", { files: 2, body: shared });
  backend(root, "tiny-b", { files: 2, body: shared });
  const repos = surveyFleet([root]);
  assert.equal(repos.filter((r) => r.mirrorOf).length, 0);
});

test("adoption posture is read from the repository, not assumed", async () => {
  const { audit } = await import(path.join(FLEET, "audit.mjs"));
  const root = tmp();
  const dir = backend(root, "adopted-app", { scannable: true });
  fs.writeFileSync(
    path.join(dir, ".convex-cost.json"),
    JSON.stringify({ guard: "0.0.9", mode: "enforce", baseline: ".convex-cost-baseline.json" }),
  );
  const result = audit([root], { scan: () => [] });
  const row = result.repos.find((r) => r.name === "adopted-app");
  assert.equal(row.adopted, true);
  assert.equal(row.mode, "enforce");
  // Behind the standard, and with no workflow, both reported as drift.
  assert.ok(row.drift.some((d) => /guard 0\.0\.9/.test(d)));
  assert.ok(row.drift.some((d) => /no CI workflow/.test(d)));
});

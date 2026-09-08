# Quarantined tests

Tests that pass on a developer's machine and fail on a clean runner. They are
run in CI, and their failure does not block a merge.

**This file is the manifest.** `.github/workflows/tests.yml` reads the list from
here rather than keeping its own copy, so a test cannot be quietly excluded by
editing a YAML line nobody reads.

## Why this exists

The Harness had no CI. Its suite passed because it was run on the laptop that
wrote it. The first time a clean Linux runner executed it, 26 of 261 tests
failed, and none of them because of the change under review.

They fail because they read the developer's machine: a real `$HOME`, a real
`~/.claude` registry, real repositories under `~/sites`, and realpath behaviour
that differs between macOS and Linux. On a runner none of that exists, so a scan
finds nothing and an assertion dereferences `undefined`.

Quarantine rather than deletion: these tests assert real behaviour and the code
they cover is not suspect. What is wrong is that they cannot say so anywhere but
one machine.

Quarantine rather than a red check: a permanently failing gate is one people
learn to ignore, and a gate that is ignored is not a gate. That is the argument
Convex Guard is built on, so it would be strange to break it here.

## The list

| File | Failures | Reason |
| --- | --- | --- |
| `test/web-scan.test.js` | 12 | Scans real project and worktree paths from `$HOME` |
| `test/rollback-reconcile.test.js` | 8 | Snapshot and drift over a real session store |
| `test/web-server.test.js` | 5 | Resolves fixture projects by realpath after a filesystem scan |
| `test/web-cli.test.js` | 1 | Boots the web CLI against a discovered project tree |

Measured on run
[34258378865](https://github.com/Atemndobs/atem-agentic-os/actions/runs/34258378865),
2026-09-08.

## Leaving quarantine

A test leaves this list when its dependency on the machine is removed, usually by
injecting the roots it scans instead of reading `$HOME`. Delete its row, and CI
starts gating it.

Tracked in [issue #3](https://github.com/Atemndobs/atem-agentic-os/issues/3).
The list is meant to shrink; a quarantine that only grows is a way of not fixing
things.

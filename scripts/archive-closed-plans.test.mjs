#!/usr/bin/env node
// archive-closed-plans.test.mjs — the archive sweep.
//
// Base scenario: a maintenance sweep moves plan files whose issues are CLOSED
// into plan/done/, leaving live plans in place, and only moves files (it never
// commits) so the archive can land as one reviewable commit.
//
// Plus one test per acceptance criterion of #50:
//   AC1 — a slug whose marker appears on both a closed AND an open issue is not
//         archived (a single open issue vetoes the archive).
//   AC2 — archiving a file whose name already exists in plan/done/ fails with a
//         clear message naming both paths, and overwrites nothing.
//
// The module runs its sweep on import (top-level await), so each scenario
// imports it under a distinct query string — a fresh module instance that
// re-reads PLAN_DIR and re-runs the sweep against that scenario's fixture.
// Zero dependencies. Run:  node scripts/archive-closed-plans.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = new URL("./archive-closed-plans.mjs", import.meta.url).href;
process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "o/r";

const respond = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

// Build a fetch stub that serves `issues` on page 1 (empty after). onWrite
// fires on any non-GET so a scenario can prove the sweep never mutates GitHub.
function fetchStub(issues, onWrite) {
  return async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    if (method !== "GET") onWrite?.();
    if (method === "GET" && pathname === "/repos/o/r/issues") {
      return respond(Number(searchParams.get("page")) === 1 ? issues : []);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
}

// Run one fresh sweep against `planDir` with `issues`, capturing output and the
// exit code (process.exit is stubbed so a failing sweep does not kill the test
// process). `tag` cache-busts the import so the module re-evaluates.
async function runSweep(tag, planDir, issues) {
  process.env.PLAN_DIR = planDir;
  let wrote = false;
  globalThis.fetch = fetchStub(issues, () => { wrote = true; });

  const logs = [], errs = [];
  const realLog = console.log, realErr = console.error, realExit = process.exit;
  let exitCode = 0;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  process.exit = (c) => { exitCode = c; };
  try {
    await import(`${MODULE}?scenario=${tag}`);
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.exit = realExit;
  }
  return { logs, errs, exitCode, wrote };
}

const planLine = (slug) => `---\ntitle: ${slug}\npriority: low\nblocked_by: []\n---\nBody.\n\n## Acceptance criteria\n- [ ] x\n`;
const issue = (number, state, slug) => ({ number, state, pull_request: undefined, body: `b\n\n<!-- plan-id: ${slug} -->` });

// === Base: closed plans archived, live/unknown plans and the archive left alone
{
  const dir = await mkdtemp(join(tmpdir(), "archive-base-"));
  await writeFile(join(dir, "0001-open.md"), planLine("0001-open"));
  await writeFile(join(dir, "0002-closed.md"), planLine("0002-closed"));
  await writeFile(join(dir, "0003-no-issue.md"), planLine("0003-no-issue"));
  await writeFile(join(dir, "README.md"), "# not a plan\n");
  await mkdir(join(dir, "done"), { recursive: true });
  await writeFile(join(dir, "done", "0000-old.md"), "already archived\n");

  const { logs, wrote } = await runSweep("base", dir, [
    issue(1, "open", "0001-open"),
    issue(2, "closed", "0002-closed"),
  ]);

  const top = await readdir(dir);
  const done = await readdir(join(dir, "done"));
  assert.ok(!top.includes("0002-closed.md"), "closed plan must leave the active dir");
  assert.ok(done.includes("0002-closed.md"), "closed plan must land in plan/done/");
  assert.ok(top.includes("0001-open.md"), "an open issue's plan must stay active");
  assert.ok(top.includes("0003-no-issue.md"), "a plan with no issue must stay (state unknown)");
  assert.ok(top.includes("README.md"), "README is never archived");
  assert.ok(done.includes("0000-old.md"), "a pre-existing archive is never re-touched");
  assert.equal(wrote, false, "the sweep must not mutate GitHub");
  assert.ok(logs.some((l) => l.includes("ARCHIVE") && l.includes("0002-closed")), "each move is logged");
  assert.ok(logs.some((l) => l.includes("reviewable commit")), "the sweep points the human at committing the moves");
}

// === AC1: a slug on both a closed AND an open issue is not archived ==========
{
  const dir = await mkdtemp(join(tmpdir(), "archive-ac1-"));
  await writeFile(join(dir, "0010-dup.md"), planLine("0010-dup"));   // closed + open share this slug -> STAYS
  await writeFile(join(dir, "0011-done.md"), planLine("0011-done")); // single closed issue -> archived (control)

  const { exitCode } = await runSweep("ac1", dir, [
    issue(10, "closed", "0010-dup"),
    issue(11, "open", "0010-dup"),   // one open issue must veto the archive
    issue(12, "closed", "0011-done"),
  ]);

  const top = await readdir(dir);
  const done = await readdir(join(dir, "done"));
  assert.ok(top.includes("0010-dup.md"), "AC1: a slug with any open issue must NOT be archived");
  assert.ok(!done.includes("0010-dup.md"), "AC1: the still-open slug's plan must not reach plan/done/");
  assert.ok(done.includes("0011-done.md"), "AC1: a fully-closed slug still archives (sweep not over-broadened)");
  assert.equal(exitCode, 0, "AC1: a clean sweep exits zero");
}

// === AC2: a name clash in plan/done/ fails loudly and overwrites nothing =====
{
  const dir = await mkdtemp(join(tmpdir(), "archive-ac2-"));
  await writeFile(join(dir, "0020-clash.md"), planLine("0020-clash"));
  await mkdir(join(dir, "done"), { recursive: true });
  const ARCHIVED = "ORIGINAL ARCHIVED HISTORY\n";
  await writeFile(join(dir, "done", "0020-clash.md"), ARCHIVED);

  const { errs, exitCode } = await runSweep("ac2", dir, [issue(20, "closed", "0020-clash")]);

  const src = join(dir, "0020-clash.md");
  const dest = join(dir, "done", "0020-clash.md");
  const top = await readdir(dir);
  assert.ok(top.includes("0020-clash.md"), "AC2: the source file is left in place (nothing moved)");
  assert.equal(await readFile(dest, "utf8"), ARCHIVED, "AC2: the existing archive is not overwritten");
  assert.ok(errs.some((e) => e.includes(src) && e.includes(dest)), "AC2: the error names both the source and destination paths");
  assert.equal(exitCode, 1, "AC2: a refused move exits non-zero");
}

console.log("PASS archive-closed-plans.test.mjs (base + AC1 + AC2)");

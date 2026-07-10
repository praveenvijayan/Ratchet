#!/usr/bin/env node
// docs-refresh.test.mjs — regression checks for docs that describe shipped
// Ratchet mechanisms. Zero dependencies. Run: node scripts/docs-refresh.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const docs = read("DOCS.md");
const readme = read("README.md");
const planReadme = read("plan/README.md");
const agents = read("AGENTS.md");

// #60 AC1: DOCS.md's sweep section describes the renewable lease, heartbeat
// marker, and all three swept states, matching the code.
{
  assert.match(docs, /state:in-progress[\s\S]*state:in-review[\s\S]*state:changes-requested/, "DOCS must name all swept states");
  assert.match(docs, /<!-- ratchet-heartbeat -->/, "DOCS must document the heartbeat marker");
  assert.match(docs, /newest proof of life|Freshness is the newest/, "DOCS must describe renewable lease freshness");
}

// #60 AC2: DOCS.md inventories all workflows and every shipped script.
{
  const workflows = readdirSync(`${root}.github/workflows`).filter((f) => f.endsWith(".yml")).sort();
  for (const workflow of workflows) assert.ok(docs.includes(workflow), `DOCS must list workflow ${workflow}`);

  const scripts = readdirSync(`${root}scripts`).filter((f) => !f.startsWith(".")).sort();
  for (const script of scripts) assert.ok(docs.includes(script), `DOCS must list script ${script}`);
}

// #60 AC3: DOCS.md's plan-format section shows optional Non-functional and
// Test notes sections.
{
  assert.match(docs, /## Non-functional[\s\S]*## Test notes/, "DOCS plan example must show both optional sections");
  assert.match(docs, /Optional `## Non-functional` and `## Test notes` sections/, "DOCS must explain optional sections");
}

// #60 AC4: README's skills list includes /ratchet-next and /ratchet-metrics.
{
  assert.ok(readme.includes("**`/ratchet-next`**"), "README must list /ratchet-next");
  assert.ok(readme.includes("**`/ratchet-metrics`**"), "README must list /ratchet-metrics");
}

// #60 AC5: plan/README.md documents invalid-priority hard-skip, unknown-key
// warning, and the cycle gate.
{
  assert.match(planReadme, /invalid priority|Priority is a closed set/, "plan README must document invalid-priority skip");
  assert.match(planReadme, /unknown frontmatter key/, "plan README must document unknown-key warnings");
  assert.match(planReadme, /Blocked-by cycles are a hard gate|cycle is a deadlock/, "plan README must document the cycle gate");
}

// #60 AC6: AGENTS.md names pr-gates CI and the extended sweep states where it
// describes the loop.
{
  assert.match(agents, /`pr-gates` workflow[\s\S]*`gates` job[\s\S]*`size` job/, "AGENTS must name the pr-gates CI check");
  assert.match(agents, /`state:in-progress`[\s\S]*`state:in-review`[\s\S]*`state:changes-requested`/, "AGENTS must name extended sweep states");
}

// --- #191 Criterion 1: node scripts/herd-ui.test.mjs exits 0 with the
// repository in its current state (plan/0069-*.md archived under plan/done/),
// and the test:herd-ui gate passes under run-gates (it is wired in GATES.md).
{
  const herdUi = readFileSync(`${root}scripts/herd-ui.test.mjs`, "utf8");
  assert.doesNotMatch(herdUi, /readFileSync\([^)]*plan[\\/]"?0?069/, "herd-ui.test.mjs reads no plan/0069 file at runtime");
  const ran = spawnSync(process.execPath, ["scripts/herd-ui.test.mjs"], { cwd: root });
  assert.equal(ran.status, 0, `herd-ui.test.mjs should exit 0 with plan/0069 archived (stderr: ${ran.stderr.toString().slice(0, 200)})`);
  const gates = read("GATES.md");
  assert.match(gates, /test:\s*herd-ui\s*\|\s*`node scripts\/herd-ui\.test\.mjs`/, "GATES.md wires the test:herd-ui gate");
}

// --- #191 Criterion 2: herd-ui.test.mjs's per-criterion self-count is derived
// from its own Criterion N markers and reads no plan/NNNN-*.md file at runtime,
// so archiving a plan when its issue closes can never break it.
{
  const src = readFileSync(`${root}scripts/herd-ui.test.mjs`, "utf8");
  const REPO_PLAN_DIR = /["']\.\.["']\s*,\s*["']plan["']|\.\.\/plan\b/;
  const ISSUE_SLUG = /\d{4}-[a-z0-9-]+\.md/i;
  assert.ok(!REPO_PLAN_DIR.test(src), "herd-ui.test.mjs never resolves the repo plan/ dir relative to its source");
  assert.ok(!ISSUE_SLUG.test(src), "herd-ui.test.mjs references no NNNN-*.md plan slug at runtime");
  assert.match(src, /CRITERIA_COUNT/, "each self-count is driven by a marker count, not a plan file");
  assert.doesNotMatch(src, /\bplanText\b/, "no planText variable remains (the old plan-derived count is gone)");
  assert.doesNotMatch(src, /\bcriteriaSection\b/, "no criteriaSection variable remains (no plan criteria are parsed)");
}

// --- #191 Criterion 3: no scripts/*.test.mjs reads a closable issue's
// plan/NNNN-*.md at runtime for a pass/fail assertion. Reading plan/README.md
// or a purpose-built fixture in a temp dir is fine — those never resolve the
// repo plan/ dir relative to the source, so they don't trip this guard.
{
  const REPO_PLAN_DIR = /["']\.\.["']\s*,\s*["']plan["']|\.\.\/plan\b/;
  const ISSUE_SLUG = /\d{4}-[a-z0-9-]+\.md/i;
  const testFiles = readdirSync(`${root}scripts`)
    .filter((f) => f.endsWith(".test.mjs") && f !== "docs-refresh.test.mjs");
  const offenders = [];
  for (const f of testFiles) {
    const s = readFileSync(`${root}scripts/${f}`, "utf8");
    if (REPO_PLAN_DIR.test(s) && ISSUE_SLUG.test(s)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `no test may read a closable issue's plan/NNNN-*.md at runtime (offenders: ${offenders.join(", ") || "none"})`);
}

// --- #191 Criterion 4: every criterion above has exactly one test named after
// it. The plan file carried four #191 acceptance criteria; this counts its own
// `#191 Criterion N` markers and proves there is exactly one per criterion,
// 1..4. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #191 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #191 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #191 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#191 criterion ${n} has a test`);
}

console.log("PASS docs-refresh.test.mjs (6 #60 criteria + 4 #191 criteria)");

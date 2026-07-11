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
const memory = read("memory/MEMORY.md");

// #60 AC1: DOCS.md's sweep section describes the renewable lease, heartbeat
// marker, and all three swept states, matching the code.
{
  assert.match(docs, /state:in-progress[\s\S]*state:in-review[\s\S]*state:changes-requested/, "DOCS must name all swept states");
  assert.match(docs, /<!-- ratchet-heartbeat -->/, "DOCS must document the heartbeat marker");
  assert.match(docs, /newest proof of life|Freshness is the newest/, "DOCS must describe renewable lease freshness");
}

// #60 AC2: DOCS.md inventories all workflows and every shipped script.
// The workflow check is scoped to the §6 workflow table (the inventory section)
// rather than the whole file, so a workflow mentioned only in prose or the
// layout listing does not satisfy the inventory — it must appear as a row in
// the table. The table uses bare names (without .yml), matching the `name:`
// field in each workflow YAML.
{
  const workflows = readdirSync(`${root}.github/workflows`).filter((f) => f.endsWith(".yml")).sort();
  const wfSection = docs.slice(docs.indexOf("## 6. Workflows"), docs.indexOf("### Security: the unattended runner"));
  assert.ok(wfSection.length > 0, "DOCS must have a §6 Workflows section to slice");
  for (const f of workflows) {
    const wfName = f.replace(/\.yml$/, "");
    assert.ok(wfSection.includes(`| \`${wfName}\` |`), `DOCS §6 workflow table must list ${wfName}`);
  }

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

// --- #91 AC1: REWORK_GRACE_HOURS is documented alongside STALE_HOURS where the
// sweep is described (the §6 workflow table entry for sweep-stale-claims) ---
{
  const wfSection = docs.slice(docs.indexOf("## 6. Workflows"), docs.indexOf("### Security: the unattended runner"));
  assert.ok(wfSection.includes("STALE_HOURS"), "the sweep-stale-claims table entry must name STALE_HOURS");
  assert.ok(wfSection.includes("REWORK_GRACE_HOURS"), "the sweep-stale-claims table entry must name REWORK_GRACE_HOURS");
}

// --- #91 AC2: the §6 workflow table lists all workflows, and the test checks
// the inventory section (the table), not the whole file — verified by the #60
// AC2 test above which slices the section. Here we assert every workflow YAML
// in .github/workflows appears as a table row (| `name` |) in the section ---
{
  const wfSection = docs.slice(docs.indexOf("## 6. Workflows"), docs.indexOf("### Security: the unattended runner"));
  const workflows = readdirSync(`${root}.github/workflows`).filter((f) => f.endsWith(".yml")).sort();
  for (const f of workflows) {
    const wfName = f.replace(/\.yml$/, "");
    assert.ok(wfSection.includes(`| \`${wfName}\` |`), `the §6 table must have a row for ${wfName}`);
  }
}

// --- #91 AC3: plan/README.md describes the abort-on-invalid-frontmatter
// semantics — the sync aborts with nothing changed, not "skips" a file ---
{
  assert.match(planReadme, /sync aborts|aborts/, "plan README must say the sync aborts on invalid frontmatter");
  assert.ok(!/the file is skipped and logged/.test(planReadme), "plan README must not say the file is 'skipped and logged'");
  assert.match(planReadme, /changing nothing|nothing was changed|no file is partially synced/, "plan README must state nothing is partially synced");
}

// --- #91 AC4: the release documentation states a first release seeds its
// version from .ratchet-version ---
{
  const wfSection = docs.slice(docs.indexOf("## 6. Workflows"), docs.indexOf("### Security: the unattended runner"));
  assert.ok(/first release.*\.ratchet-version|\.ratchet-version.*first release/i.test(wfSection), "the release table row must state a first release seeds from .ratchet-version");
  assert.ok(/first release/i.test(wfSection), "the release table row must mention 'first release'");
}

// --- #233 Criterion 1: AGENTS.md contains no RTK/headroom instruction block
// and no directive requiring shell commands to be prefixed with rtk. ---

{
  assert.doesNotMatch(agents, /headroom:rtk-instructions/, "AGENTS.md must not contain the headroom RTK block");
  assert.doesNotMatch(agents, /RTK \(Rust Token Killer\)/, "AGENTS.md must not contain the RTK guidance heading");
  assert.doesNotMatch(
    agents,
    /(?:always\s+)?prefix(?:\s+\w+){0,8}\s+with\s+`rtk`/i,
    "AGENTS.md must not require shell commands to be prefixed with rtk",
  );
}

// --- #233 Criterion 2: memory/MEMORY.md contains the relocated RTK guidance,
// including command examples and rules, without loss of content. ---

{
  const required = [
    "RTK (Rust Token Killer)",
    "always prefix with `rtk`",
    "60-90%",
    "rtk git status",
    "rtk read <file>",
    "rtk pytest tests/",
    "rtk tsc",
    "rtk gh pr view <n>",
    "rtk docker ps",
    "rtk pip list",
    "In command chains, prefix each segment",
    "For debugging, use raw commands without the `rtk` prefix",
    "`rtk proxy <cmd>` runs a command without filtering but tracks usage",
  ];
  for (const text of required) {
    assert.ok(memory.includes(text), `memory/MEMORY.md must preserve RTK guidance: ${text}`);
  }
}

// --- #233 Criterion 3: every criterion above has exactly one test named after
// it. ---

{
  const self = read("scripts/docs-refresh.test.mjs");
  for (const n of [1, 2, 3]) {
    const hits = (self.match(new RegExp(`#233 Criterion ${n}:`, "g")) || []).length;
    assert.equal(hits, 1, `#233 Criterion ${n} must have exactly one named test`);
  }
}

// --- #268 Criterion 1: AGENTS.md instructs agents to update their branch onto
// latest `main` (resolving conflicts) before moving the issue to
// `state:in-review`. ---
{
  const handoff = agents.slice(
    agents.indexOf("### 5. Hand off"),
    agents.indexOf("### 6. Rework"),
  );
  assert.ok(handoff.length > 0, "AGENTS must have a §5 Hand off section to slice");
  assert.match(
    handoff,
    /bring the latest `main` into your branch[\s\S]*resolve any conflicts/,
    "AGENTS §5 must tell agents to update their branch onto latest main and resolve conflicts",
  );
  // The instruction must precede the state:in-review flip within §5.
  assert.ok(
    handoff.indexOf("bring the latest `main`") < handoff.indexOf("Set the issue to"),
    "AGENTS §5 must require the branch update before the state:in-review flip",
  );
}

// --- #268 Criterion 2: AGENTS.md documents that a PR with merge conflicts
// triggers no event-driven workflows — no gates, no review-verdict — and is
// therefore not reviewable until conflicts are resolved. ---
{
  assert.match(
    agents,
    /a PR with merge conflicts gets no\s+event-driven CI at all/,
    "AGENTS must document that a conflicted PR gets no event-driven CI",
  );
  assert.match(
    agents,
    /`pr-gates` \*\*and\*\*\s*`review-verdict`[\s\S]*silently \*skipped\*/,
    "AGENTS must name pr-gates and review-verdict as silently skipped on a conflicted PR",
  );
  assert.match(
    agents,
    /not reviewable/,
    "AGENTS must state that conflicted, un-gated work is not reviewable",
  );
}

// --- #268 Criterion 3: every #268 criterion above has exactly one test named
// after it. ---
{
  const self = read("scripts/docs-refresh.test.mjs");
  for (const n of [1, 2]) {
    const hits = (self.match(new RegExp(`#268 Criterion ${n}:`, "g")) || []).length;
    assert.equal(hits, 1, `#268 Criterion ${n} must have exactly one named test`);
  }
}

console.log("PASS docs-refresh.test.mjs (6 #60 criteria + 4 #191 criteria + 4 #91 criteria + 3 #233 criteria + 2 #268 criteria)");

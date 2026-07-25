#!/usr/bin/env node
// plan-authoring-rules.test.mjs — behaviour tests for issue #362: the plan
// authoring rules that stop the #346 mis-scope (ordering stated only in prose,
// and a batch-wide invariant written as a bare member criterion). Zero deps.
// Run: node scripts/plan-authoring-rules.test.mjs
//
// One test per acceptance criterion, exercised through the public interface
// (the canonical ratchet-plan skill, plan/README.md, and the parity guard),
// never against internals.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const skill = readFileSync(
  fileURLToPath(new URL("../.agents/skills/ratchet-plan/SKILL.md", import.meta.url)),
  "utf8",
);
const readme = readFileSync(
  fileURLToPath(new URL("../plan/README.md", import.meta.url)),
  "utf8",
);

// --- Criterion 1: the ratchet-plan skill's plan-writing step instructs that
// any ordering or sequencing stated in a plan file's prose must also be encoded
// as blocked_by slugs, and that a criterion satisfiable only after other issues
// merge means the blocker list is incomplete.
{
  assert.match(
    skill,
    /ordering or sequencing[\s\S]*?prose[\s\S]*?must also[\s\S]*?blocked_by/i,
    "skill must instruct that prose ordering must also be encoded as blocked_by slugs",
  );
  assert.match(
    skill,
    /satisfied \*?after\*? other issues merge[\s\S]*?blocker list is incomplete/i,
    "skill must state a criterion satisfiable only after other issues merge means the blocker list is incomplete",
  );
}

// --- Criterion 2: the ratchet-plan skill's plan-writing step instructs that a
// repo-wide invariant is phrased as "add an automated check that enforces X",
// placed on a capstone issue blocked on every prerequisite, never as a bare
// assertion criterion on a member issue.
{
  assert.match(
    skill,
    /add an automated check that enforces X/,
    'skill must instruct phrasing a repo-wide invariant as "add an automated check that enforces X"',
  );
  assert.match(
    skill,
    /capstone[\s\S]*?blocked_by[\s\S]*?every prerequisite/i,
    "skill must instruct placing the invariant on a capstone issue blocked on every prerequisite",
  );
  assert.match(
    skill,
    /[Nn]ever write it as a bare assertion criterion on a member/i,
    "skill must forbid a bare assertion criterion on a member issue",
  );
}

// --- Criterion 3: plan/README.md's criteria guidance documents both rules with
// the #346 shape as the counter-example.
{
  assert.match(
    readme,
    /ordering[\s\S]*?must \*?\*?also\*?\*? appear as[\s\S]*?blocked_by/i,
    "plan/README.md must document the prose-ordering rule",
  );
  assert.match(
    readme,
    /add an automated check that enforces X/,
    "plan/README.md must document the capstone-invariant rule",
  );
  assert.match(
    readme,
    /#346/,
    "plan/README.md must use the #346 shape as the counter-example",
  );
  assert.match(
    readme,
    /Counter-example/i,
    "plan/README.md must present #346 explicitly as a counter-example",
  );
}

// --- Criterion 4: the .claude/skills and plugin/skills mirrors are identical to
// the canonical skill after ./setup.sh, and scripts/skill-parity.mjs passes.
{
  const claudeMirror = readFileSync(
    fileURLToPath(new URL("../.claude/skills/ratchet-plan/SKILL.md", import.meta.url)),
    "utf8",
  );
  const pluginMirror = readFileSync(
    fileURLToPath(new URL("../plugin/skills/ratchet-plan/SKILL.md", import.meta.url)),
    "utf8",
  );
  assert.equal(claudeMirror, skill, ".claude/skills mirror must equal canonical after ./setup.sh");
  assert.equal(pluginMirror, skill, "plugin/skills mirror must equal canonical after ./setup.sh");

  const guard = fileURLToPath(new URL("./skill-parity.mjs", import.meta.url));
  const res = spawnSync("node", [guard], { encoding: "utf8", cwd: repoRoot });
  assert.equal(res.status, 0, `skill-parity.mjs must pass: ${res.stdout || res.stderr}`);
}

// --- Criterion 5: every criterion above has exactly one test named after it.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (let n = 1; n <= 5; n++) {
    const hits = (self.match(new RegExp(`--- Criterion ${n}:`, "g")) || []).length;
    assert.equal(hits, 1, `expected exactly one "Criterion ${n}" test block, found ${hits}`);
  }
}

// --- #467 Criterion 5: plan/README.md documents the estimated_lines size
// budget — hand-written changed lines only, generated files excluded, and an
// estimate over 400 means splitting the plan before any code is written. This
// lives here rather than in plan-sync.test.mjs because that suite writes
// NNNN-*.md fixtures, and the #191 guard forbids a test file that names plan
// slugs from also resolving the repo's plan/ directory.
{
  assert.match(readme, /estimated_lines/, "plan/README.md must document the estimated_lines key");
  assert.match(readme, /hand-written changed lines/i, "plan/README.md must say the estimate counts hand-written changed lines");
  assert.match(readme, /generated files[\s\S]{0,20}excluded/i, "plan/README.md must say generated files are excluded from the estimate");
  assert.match(
    readme,
    /over 400 means split[\s\S]{0,60}before writing any code/i,
    "plan/README.md must say an estimate over 400 means splitting the plan before writing code",
  );
}

// --- #469 Criterion 1: plan/README.md documents the verifiability rule — every
// criterion provable by the building agent via a named mechanism (a test, a
// command, or an observable check) — with a before/after rewrite example of an
// unverifiable criterion.
{
  assert.match(
    readme,
    /provable by the\s+building agent/i,
    "plan/README.md must require every criterion to be provable by the building agent",
  );
  for (const mechanism of [/a \*\*test\*\* the agent can run/, /a \*\*command\*\* whose exit code decides/, /an \*\*observable check\*\*/]) {
    assert.match(readme, mechanism, `plan/README.md must name the mechanism: ${mechanism}`);
  }
  const example = readme.slice(readme.indexOf("Before — unverifiable"), readme.indexOf("The \"before\" form"));
  assert.ok(example.length > 0, "plan/README.md must carry a before/after rewrite example");
  assert.match(example, /- \[ \] Sign-in works on staging/, "the before example must show the unverifiable criterion");
  assert.match(example, /After — verifiable/, "the example must show the rewritten criterion");
  assert.match(example, /returns 200 and a session cookie[\s\S]*test:/, "the after example must name the outcome and the test that proves it");
}

// --- #469 Criterion 2: plan/README.md documents the optional ## Human runbook
// section — plain `-` bullets, never `- [ ]` — for checks only a human can
// perform, carried into the issue verbatim like the other optional sections.
// (That the sync really carries it verbatim is asserted behaviourally in
// plan-sync.test.mjs, which can write NNNN-*.md fixtures; the #191 guard forbids
// this file from doing both.)
{
  assert.match(readme, /## Human runbook/, "plan/README.md must document the ## Human runbook section");
  assert.match(
    readme,
    /`## Human runbook`\*\*[\s\S]{0,120}only a human can perform/i,
    "plan/README.md must define ## Human runbook as checks only a human can perform",
  );
  assert.match(
    readme,
    /carries the section into the issue verbatim/i,
    "plan/README.md must state the sync carries ## Human runbook into the issue verbatim",
  );
  assert.match(
    readme,
    /plain `-` bullets in all three sections, never `- \[ \]`/,
    "plan/README.md must require plain `-` bullets in all three optional sections",
  );
}

// --- #469 Criterion 3: plan/README.md states that UI/behaviour criteria require
// behaviour tests and that a test asserting on source strings does not satisfy a
// criterion.
{
  assert.match(
    readme,
    /UI and behaviour criteria require behaviour tests/i,
    "plan/README.md must require behaviour tests for UI/behaviour criteria",
  );
  assert.match(
    readme,
    /a test that asserts on\s+source strings does not satisfy a criterion/i,
    "plan/README.md must state a source-string assertion does not satisfy a criterion",
  );
  assert.match(
    readme,
    /source-string assertion is \*\*unmet\*\*/,
    "plan/README.md must call a source-string-only criterion unmet",
  );
}

// --- #469 Criterion 4: AGENTS.md's review step instructs the reviewer to reject
// a PR whose criterion-mapped test asserts on source text instead of behaviour.
{
  const agents = readFileSync(fileURLToPath(new URL("../AGENTS.md", import.meta.url)), "utf8");
  const start = agents.indexOf("### 6. Rework");
  assert.ok(start >= 0, "AGENTS.md must have a §6 review/rework step");
  const step6 = agents.slice(start, agents.indexOf("\n## ", start));
  assert.ok(step6.length > 0, "AGENTS.md §6 must be sliceable");
  assert.match(step6, /review/i, "AGENTS.md §6 must be the review step");
  assert.match(
    step6.replace(/\s+/g, " "),
    /reject it when a criterion-mapped test asserts on source text instead of behaviour/i,
    "AGENTS.md §6 must instruct the reviewer to reject source-text criterion tests",
  );
  assert.match(step6.replace(/\s+/g, " "), /criterion is \*\*unmet\*\*/, "AGENTS.md §6 must call that criterion unmet");
}

// --- #469 Criterion 5 is asserted in plan-sync.test.mjs (a plan file without
// ## Human runbook compiles and syncs exactly as before): that suite writes
// NNNN-*.md fixtures, and the #191 guard forbids a test file that names plan
// slugs from also resolving the repo's plan/ directory.

// --- #468 Criterion 6: plan/README.md documents the `locks` key with its token
// conventions (migration, route:<path>, file:<path>). Asserted here for the same
// reason as #467 criterion 5: plan-sync.test.mjs writes NNNN-*.md fixtures, and
// the #191 guard forbids a test file that names plan slugs from also resolving
// the repo's plan/ directory.
{
  assert.match(readme, /## Exclusive resources — `locks`/, "plan/README.md must document the locks key");
  for (const token of [/`migration`/, /`route:<path>`/, /`file:<path>`/]) {
    assert.match(readme, token, `plan/README.md must document the token convention: ${token}`);
  }
  assert.match(
    readme,
    /compared as exact strings/i,
    "plan/README.md must state that lock tokens are compared as exact strings",
  );
  assert.match(
    readme,
    /priority first, then slug/i,
    "plan/README.md must state that the serialization order is priority then slug",
  );
}

// --- #472 Criterion 4: plan/README.md documents the `risk` closed set and the
// rule that schema, auth, secrets, billing, `infra/**`, and `.github/**` work
// must declare `risk: high`. Asserted here for the same reason as #467/#468
// above: plan-sync.test.mjs writes NNNN-*.md fixtures and the #191 guard forbids
// it from also resolving the repo's plan/ directory.
{
  assert.match(readme, /## Review tier — `risk`/, "plan/README.md must document the risk key");
  assert.match(
    readme,
    /closed set: `high` or `normal`/,
    "plan/README.md must state that risk is a closed set of high and normal",
  );
  for (const area of [/\bschema\b/, /\bauth\b/, /\bsecrets\b/, /\bbilling\b/, /`infra\/\*\*`/, /`\.github\/\*\*`/]) {
    assert.match(readme, area, `plan/README.md must name the mandatory-high area: ${area}`);
  }
  assert.match(
    readme,
    /must declare `risk: high`/,
    "plan/README.md must state that work in those areas must declare risk: high",
  );
}

// --- #470 Criterion 4: plan/README.md documents the vertical-slice rule — a
// plan delivers a working end-to-end path, or declares `stub: true` and names a
// `repaid_by` plan file created in the same planning PR. Asserted here for the
// same reason as #467/#468/#472 above.
{
  assert.match(readme, /## Vertical slice — `stub` and `repaid_by`/, "plan/README.md must document the stub and repaid_by keys");
  assert.match(
    readme,
    /delivers a working end-to-end path/i,
    "plan/README.md must state that a plan delivers a working end-to-end path",
  );
  assert.match(
    readme,
    /created in the same planning PR/i,
    "plan/README.md must state that the repayment plan file is created in the same planning PR",
  );
  assert.match(
    readme,
    /aborts the sync non-zero/i,
    "plan/README.md must state that an unrepaid stub aborts the sync",
  );
}

console.log("PASS plan-authoring-rules.test.mjs (5 criteria + #467/#468/#469/#470/#472 README docs)");

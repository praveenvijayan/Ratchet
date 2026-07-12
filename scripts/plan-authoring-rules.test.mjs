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

console.log("PASS plan-authoring-rules.test.mjs (5 criteria)");

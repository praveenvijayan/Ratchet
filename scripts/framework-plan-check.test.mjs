#!/usr/bin/env node
// framework-plan-check.test.mjs — behaviour tests for the framework-plan gate.
// Zero dependencies. Run: node scripts/framework-plan-check.test.mjs
//
// One test per acceptance criterion of issue #473, exercised through the
// public interface (invoking scripts/framework-plan-check.mjs as a subprocess
// with the PR inputs the pr-gates workflow passes in as env vars):
//   1. A PR touching scripts/** or .github/workflows/** without a plan-id
//      marker on its issue fails, naming the paths and the plan protocol.
//   2. A PR touching neither path is unaffected.
//   3. The override label passes the check and leaves an audit trail.
//   4. AGENTS.md states framework changes follow the same plan protocol.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fileURLToPath (not url.pathname) so a repo path containing spaces decodes
// back to the real filename rather than a percent-encoded one.
const SCRIPT = fileURLToPath(new URL("./framework-plan-check.mjs", import.meta.url));
const AGENTS = fileURLToPath(new URL("../AGENTS.md", import.meta.url));

// Drive the CLI the way the workflow does, but with the PR payload injected so
// the test never touches the network.
function check({ files = [], headRef = "agent/issue-473", body = "", labels = "", issueBody = "" }) {
  const env = {
    PATH: process.env.PATH,
    PR_NUMBER: "999",
    PR_FILES_JSON: JSON.stringify(files.map((f) => ({ filename: f }))),
    PR_HEAD_REF: headRef,
    PR_BODY: body,
    PR_LABELS: labels,
    ISSUE_BODY: issueBody,
  };
  const run = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

const PLANNED = "Body text\n\n<!-- plan-id: 0198-framework-work-through-plans -->";

// 1. Framework paths with no plan-id marker → red, naming paths and protocol.
{
  const { code, out } = check({
    files: ["scripts/herd.mjs", ".github/workflows/pr-gates.yml", "README.md"],
    issueBody: "A hand-written issue with no marker.",
  });
  assert.equal(code, 1, "an unplanned framework change must fail the check");
  assert.match(out, /scripts\/herd\.mjs/, "the message must name the offending script path");
  assert.match(out, /\.github\/workflows\/pr-gates\.yml/, "the message must name the offending workflow path");
  assert.doesNotMatch(out, /- README\.md/, "non-framework paths are not offending paths");
  assert.match(out, /plan\/README\.md/, "the message must point at the plan protocol");
  assert.match(out, /no <!-- plan-id: \.\.\. --> marker/, "the message must say what was missing");

  // The same PR passes once its issue carries the marker plan-sync stamps.
  const planned = check({ files: ["scripts/herd.mjs"], issueBody: PLANNED });
  assert.equal(planned.code, 0, "a framework change traced to a planned issue must pass");
  assert.match(planned.out, /0198-framework-work-through-plans/, "the pass message must quote the plan-id it traced to");
}

// 2. Regression: PRs touching neither path are unaffected.
{
  const { code, out } = check({
    files: ["README.md", "plan/0198-framework-work-through-plans.md", "memory/MEMORY.md"],
    issueBody: "No marker here either.",
  });
  assert.equal(code, 0, "a PR touching no framework path must pass regardless of plan-id");
  assert.match(out, /touches no framework paths/, "the check must say why it did not apply");
}

// 3. Emergency override passes and leaves a visible audit trail on the PR.
{
  const { code, out } = check({
    files: ["scripts/herd.mjs"],
    labels: "priority:high, override:framework-plan",
    issueBody: "Unplanned emergency fix.",
  });
  assert.equal(code, 0, "the override label must let an emergency framework change through");
  assert.match(out, /OVERRIDDEN by the `override:framework-plan` label/, "the override must be stated, not silent");
  assert.match(out, /<!-- ratchet:framework-plan-check -->/, "the audit comment must carry its marker so it updates in place");
  assert.match(out, /scripts\/herd\.mjs/, "the audit trail must name the paths let through");
  assert.match(out, /::warning::/, "an override must annotate the run, never pass quietly");

  // Any other label is not the override.
  const unrelated = check({ files: ["scripts/herd.mjs"], labels: "priority:high", issueBody: "Unplanned." });
  assert.equal(unrelated.code, 1, "only the override label overrides");
}

// 4. The kernel states that framework work follows the same plan protocol.
{
  const agents = readFileSync(AGENTS, "utf8");
  assert.match(agents, /`scripts\/\*\*`/, "AGENTS.md must name scripts/** as framework work");
  assert.match(agents, /no version-update lane/i, "AGENTS.md must rule out a second lane for framework work");
}

console.log("framework-plan-check.test.mjs: all checks passed");

#!/usr/bin/env node
// ratchet-hotfix-skill.test.mjs — behaviour tests for the human-triggered
// hotfix/revert fast-lane skill contract. Zero dependencies.
// Run: node scripts/ratchet-hotfix-skill.test.mjs
//
// One test per acceptance criterion of issue #338, exercised through the
// public interface (the canonical skill file and its mirrors), never against
// internals.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const canonical = readFileSync(
  fileURLToPath(new URL("../.agents/skills/ratchet-hotfix/SKILL.md", import.meta.url)),
  "utf8",
);
const openai = readFileSync(
  fileURLToPath(new URL("../.agents/skills/ratchet-hotfix/agents/openai.yaml", import.meta.url)),
  "utf8",
);

// --- Criterion 1: canonical skill exists with disable-model-invocation and
// frontmatter matching the conventions of the existing ratchet skills.
{
  assert.ok(
    /---\n[\s\S]*?^name: ratchet-hotfix$/m.test(canonical),
    "skill frontmatter must declare name: ratchet-hotfix",
  );
  assert.match(
    canonical,
    /^disable-model-invocation: true$/m,
    "skill must set disable-model-invocation: true so it is explicit-invoke only",
  );
  assert.match(
    canonical,
    /^description: [\s\S]+?$/m,
    "skill must carry a description field like the other ratchet skills",
  );
  assert.match(
    canonical,
    /^allowed-tools: /m,
    "skill must declare an allowed-tools allowlist like the other ratchet skills",
  );
  // The Codex policy mirrors the explicit-only convention of the other skills.
  assert.match(
    openai,
    /allow_implicit_invocation: false/,
    "Codex policy must mark the skill explicit-invoke only",
  );
}

// --- Criterion 2: the skill states the lane exists only on an explicit human
// "hotfix" or "revert PR #M" trigger, that suspicion alone means report and
// wait, and that the agent never self-invokes the lane.
{
  assert.match(
    canonical,
    /explicit human trigger/i,
    "skill must state the lane is explicit-human-trigger only",
  );
  assert.match(
    canonical,
    /"hotfix"|"revert PR #M"/,
    "skill must name the human's 'hotfix' or 'revert PR #M' trigger",
  );
  assert.match(
    canonical,
    /suspect[\s\S]*?report[\s\S]*?wait/i,
    "skill must state suspicion alone means report and wait",
  );
  assert.match(
    canonical,
    /never self-invoke/i,
    "skill must state the agent never self-invokes the lane",
  );
}

// --- Criterion 3: the procedure prefers git revert -m 1 of the causal merge
// on a fresh hotfix/<slug> branch from current main in a worktree, allows a
// minimal forward fix only when revert cannot express the correction, requires
// green GATES.md gates before the PR, requires a PR titled hotfix: <what broke>
// naming the offending merge, and ends at the PR with no merge.
{
  assert.match(
    canonical,
    /git revert -m 1 <merge-sha>/,
    "skill must prefer git revert -m 1 of the causal merge",
  );
  assert.match(
    canonical,
    /hotfix\/<slug>/,
    "skill must use a fresh hotfix/<slug> branch",
  );
  assert.match(
    canonical,
    /worktree/,
    "skill must do the work in a worktree, never by switching the shared clone",
  );
  assert.match(
    canonical,
    /forward fix only when revert cannot express/i,
    "skill must allow a forward fix only when revert cannot express the correction",
  );
  assert.match(
    canonical,
    /GATES\.md[\s\S]*?fail-fast/i,
    "skill must require green GATES.md gates, fail-fast, before the PR",
  );
  assert.match(
    canonical,
    /hotfix: <what broke>/,
    "skill must require a PR titled hotfix: <what broke>",
  );
  assert.match(
    canonical,
    /naming the offending merge|names the offending merge/i,
    "skill must require the PR to name the offending merge",
  );
  assert.match(
    canonical,
    /stop for human review[\s\S]*?never merge/i,
    "skill must end at the PR with no merge",
  );
}

// --- Criterion 4: the skill requires a follow-up root-cause plan file via
// /ratchet-plan and states a hotfix without one is unfinished.
{
  assert.match(
    canonical,
    /\/ratchet-plan/,
    "skill must require the follow-up via /ratchet-plan",
  );
  assert.match(
    canonical,
    /root cause/i,
    "skill must require the plan file to capture the root cause",
  );
  assert.match(
    canonical,
    /unfinished hotfix|hotfix with no follow-up[\s\S]*?unfinished/i,
    "skill must state a hotfix without a follow-up plan file is unfinished",
  );
}

// --- Criterion 5: .claude/skills and plugin/skills mirrors are identical to
// the canonical skill after running ./setup.sh, and skill-parity.mjs passes.
{
  const claudeMirror = readFileSync(
    fileURLToPath(new URL("../.claude/skills/ratchet-hotfix/SKILL.md", import.meta.url)),
    "utf8",
  );
  const pluginMirror = readFileSync(
    fileURLToPath(new URL("../plugin/skills/ratchet-hotfix/SKILL.md", import.meta.url)),
    "utf8",
  );
  assert.equal(claudeMirror, canonical, ".claude/skills mirror must equal canonical");
  assert.equal(pluginMirror, canonical, "plugin/skills mirror must equal canonical");

  // The canonical skill also carries its Codex policy.
  assert.ok(
    existsSync(fileURLToPath(new URL("../.agents/skills/ratchet-hotfix/agents/openai.yaml", import.meta.url))),
    "canonical skill must carry agents/openai.yaml",
  );

  // The parity guard itself passes against this repo.
  const guard = fileURLToPath(new URL("./skill-parity.mjs", import.meta.url));
  const res = spawnSync("node", [guard], { encoding: "utf8", cwd: repoRoot });
  assert.equal(res.status, 0, `skill-parity.mjs must pass: ${res.stdout || res.stderr}`);
  assert.match(res.stdout, /12 skill/i, "parity guard must report the ratchet-hotfix skill among those verified");
}

// --- Criterion 6: AGENTS.md is unchanged by this PR (the manual shrink happens
// in 0143-slim-agent-manual).
{
  // The PR branch must not touch AGENTS.md. Compare the worktree's AGENTS.md
  // against origin/main's copy: a clean diff is the only acceptable state.
  const diff = spawnSync(
    "git",
    ["diff", "origin/main", "--", "AGENTS.md"],
    { encoding: "utf8", cwd: repoRoot },
  );
  assert.equal(diff.status, 0, `git diff of AGENTS.md failed: ${diff.stderr}`);
  assert.equal(
    diff.stdout.trim(),
    "",
    "AGENTS.md must be unchanged by this PR — the manual shrink is a separate issue (0143)",
  );
}

// --- Criterion 7: every criterion above has exactly one test (meta).
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (let n = 1; n <= 7; n++) {
    const hits = (self.match(new RegExp(`--- Criterion ${n}:`, "g")) || []).length;
    assert.equal(hits, 1, `expected exactly one "Criterion ${n}" test block, found ${hits}`);
  }
}

console.log("PASS ratchet-hotfix-skill.test.mjs (7 criteria)");

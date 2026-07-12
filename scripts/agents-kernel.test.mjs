#!/usr/bin/env node
// agents-kernel.test.mjs — behaviour tests for issue #334: AGENTS.md rewritten
// as a compact always-loaded safety kernel. Zero dependencies.
// Run: node scripts/agents-kernel.test.mjs
//
// One test per acceptance criterion, exercised through the public interface (the
// rendered AGENTS.md, the routed files on disk, and the existing doc gates),
// never against internals. Phrase matches run against a whitespace-normalised
// copy so a line wrap inside a required phrase never masks its presence.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const agents = readFileSync(fileURLToPath(new URL("../AGENTS.md", import.meta.url)), "utf8");
const flat = agents.replace(/\s+/g, " ");
const resolve = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

// The nine hard rules (0–8) each carry an invariant marker; reused by several
// criteria below.
const INVARIANT_IDS = [
  "no-issue-no-edits", "plan-source", "claim-ref", "criteria-only",
  "never-red-pr", "one-pr", "never-merge", "labelled-exit", "error-paths",
];

// --- Criterion 1: AGENTS.md retains, in normative form, every named invariant.
{
  const required = [
    [/eight-plus-zero hard rules/, INVARIANT_IDS.every((id) => agents.includes(`<!-- ratchet:invariant:${id} -->`)), "eight-plus-zero hard rules"],
    [null, /before any local work/i.test(flat), "claim-before-any-local-work ordering"],
    [null, /as a worktree only/i.test(flat) && /shared clone (?:stays parked on `main`|never changes branches|never leaves)/i.test(flat), "worktree-only attachment, clone parked on main"],
    [null, /--ff-only/.test(flat), "--ff-only integration"],
    [null, /\.ratchet-owner/.test(flat) && /explicit(?:ly)? hand/i.test(flat), "ownership proof and explicit-handoff"],
    [null, /~400 changed lines/.test(flat) && /split/i.test(flat) && /requeue/i.test(flat), "scope cap with split-and-requeue"],
    [null, /one test per criterion/i.test(flat) && /## Test notes/.test(agents) && /## Non-functional/.test(agents), "one-test-per-criterion with Test notes / Non-functional"],
    [null, /Error paths ship with the feature/i.test(flat), "error-path completion rule"],
    [null, /renew your lease/i.test(flat) && /ratchet-heartbeat/.test(flat), "heartbeat lease requirement"],
    [null, /state machine/i.test(flat), "label state machine"],
    [null, /memory\/USER\.md/.test(flat) && /you never edit/i.test(flat), "memory read rule with USER.md never edited"],
    [null, /explicit human trigger/i.test(flat) && /never\s*self-invoke/i.test(flat), "hotfix explicit-human-trigger-only prohibition"],
  ];
  for (const [, ok, label] of required) {
    assert.ok(ok, `AGENTS.md must retain the invariant: ${label}`);
  }
}

// --- Criterion 2: the routing table routes every deferred concern by a file
// path (not a skill invocation), and every routed path exists in the repo.
{
  const start = agents.indexOf("## Routing table");
  assert.ok(start >= 0, "AGENTS.md must have a routing table");
  const section = agents.slice(start, agents.indexOf("## Deterministic commands"));
  assert.ok(section.length > 0, "routing table section must be sliceable");
  // Extract every backticked token in the table's route column that looks like a
  // path (contains a slash or a known doc filename), and assert each exists.
  const paths = [...section.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((t) => t.includes("/") || /\.md$/.test(t))
    .filter((t) => !t.includes("*")); // skip the plan/*.md glob mention
  assert.ok(paths.length >= 8, `routing table must route several concerns by path (found ${paths.length})`);
  for (const p of paths) {
    assert.ok(existsSync(resolve(p)), `routed path must exist in the repo: ${p}`);
  }
  // Routes are file paths, not skill invocations: no `/ratchet-*` slash command
  // appears as a route inside the table.
  assert.ok(!/\|\s*`\/ratchet-/.test(section), "routing table must route by file path, not by skill invocation");
}

// --- Criterion 3: claim, requeue, heartbeat, and handoff are single
// `node scripts/ratchet-*.mjs` commands with exit-code meanings, and the
// multi-step shell recipes they replace are gone from the manual.
{
  const commands = [
    "node scripts/ratchet-start.mjs --issue <N> --owner",
    "node scripts/ratchet-requeue.mjs --issue <N> --reason",
    "node scripts/ratchet-heartbeat.mjs --issue <N>",
    "node scripts/ratchet-submit.mjs --issue <N> --body-file",
  ];
  for (const c of commands) {
    assert.ok(flat.includes(c), `manual must invoke the deterministic command: ${c}`);
  }
  // Each command documents exit codes (the "exit 0 ... 2 ..." shorthand).
  for (const s of ["ratchet-start.mjs", "ratchet-requeue.mjs", "ratchet-heartbeat.mjs", "ratchet-submit.mjs"]) {
    const i = flat.indexOf(s);
    assert.match(flat.slice(i, i + 260), /exit `?0`?/i, `${s} must document its exit codes`);
  }
  // The multi-step shell recipes the scripts replaced are gone.
  const goneRecipes = [
    /gh api repos\/\{owner\}\/\{repo\}\/git\/refs/,
    /git worktree add \.\.\/wt\/issue-/,
    /SHA=\$\(gh api/,
  ];
  for (const r of goneRecipes) {
    assert.doesNotMatch(agents, r, `the replaced shell recipe must be gone from the manual: ${r}`);
  }
}

// --- Criterion 4: each hard rule carries a machine-readable invariant marker.
{
  for (const id of INVARIANT_IDS) {
    const marker = `<!-- ratchet:invariant:${id} -->`;
    assert.equal(
      (agents.match(new RegExp(marker.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"), "g")) || []).length,
      1,
      `exactly one hard rule must carry ${marker}`,
    );
  }
  // The count of invariant markers equals the count of hard rules (0–8).
  const markers = (agents.match(/<!-- ratchet:invariant:[a-z-]+ -->/g) || []).length;
  assert.equal(markers, 9, `expected 9 invariant markers (hard rules 0–8), found ${markers}`);
}

// --- Criterion 5: an automated comparison against the pre-change AGENTS.md
// reports byte and token reductions and fails unless both are at least 40%.
// Baseline measured from AGENTS.md at commit 70dd869 (the pre-#334 manual),
// tokenised by the same whitespace tokenizer used here. The pre-change content
// is recoverable from git history at that SHA.
{
  const BASELINE_BYTES = 26075;
  const BASELINE_TOKENS = 4075;
  const tokenize = (s) => s.match(/\S+/g) || [];
  const bytes = Buffer.byteLength(agents, "utf8");
  const tokens = tokenize(agents).length;
  const byteReduction = 1 - bytes / BASELINE_BYTES;
  const tokenReduction = 1 - tokens / BASELINE_TOKENS;
  assert.ok(
    byteReduction >= 0.4,
    `byte reduction must be >= 40% (baseline ${BASELINE_BYTES} → ${bytes}, ${(byteReduction * 100).toFixed(1)}%)`,
  );
  assert.ok(
    tokenReduction >= 0.4,
    `token reduction must be >= 40% (baseline ${BASELINE_TOKENS} → ${tokens}, ${(tokenReduction * 100).toFixed(1)}%)`,
  );
  console.log(`  reductions: bytes ${(byteReduction * 100).toFixed(1)}%, tokens ${(tokenReduction * 100).toFixed(1)}%`);
}

// --- Criterion 6: a parity check verifies the kernel still names the required
// commands, state and priority labels, branch patterns, heartbeat marker,
// ownership marker, and safety prohibitions.
{
  const mustName = [
    "scripts/ratchet-start.mjs", "scripts/ratchet-requeue.mjs",
    "scripts/ratchet-heartbeat.mjs", "scripts/ratchet-submit.mjs",
    "state:draft", "state:ready", "state:in-progress", "state:in-review",
    "state:changes-requested", "state:blocked",
    "priority:high", "priority:medium", "priority:low",
    "agent/issue-<N>", "<!-- ratchet-heartbeat -->", ".ratchet-owner",
  ];
  for (const s of mustName) {
    assert.ok(agents.includes(s), `parity: kernel must name ${s}`);
  }
  // Safety prohibitions.
  assert.match(flat, /never merge, approve, close/i, "parity: kernel must state the never-merge prohibition");
  assert.match(flat, /explicit human trigger/i, "parity: kernel must state the hotfix trigger prohibition");
}

// --- Criterion 7: the existing documentation gates pass against the rewritten
// manual.
{
  for (const suite of ["docs-refresh.test.mjs", "state-instructions-symmetry.test.mjs"]) {
    const res = spawnSync("node", [`scripts/${suite}`], { encoding: "utf8", cwd: repoRoot });
    assert.equal(res.status, 0, `${suite} must pass against the rewritten AGENTS.md: ${res.stdout || res.stderr}`);
  }
}

// --- Criterion 8: every criterion above has exactly one test named after it.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (let n = 1; n <= 8; n++) {
    const hits = (self.match(new RegExp(`--- Criterion ${n}:`, "g")) || []).length;
    assert.equal(hits, 1, `expected exactly one "Criterion ${n}" test block, found ${hits}`);
  }
}

console.log("PASS agents-kernel.test.mjs (8 criteria)");

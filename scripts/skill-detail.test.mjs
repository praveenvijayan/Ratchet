#!/usr/bin/env node
// skill-detail.test.mjs — behaviour tests for the owned-skill-detail guard.
// Zero dependencies. Run:  node scripts/skill-detail.test.mjs
//
// One test per acceptance criterion of issue #339, exercised through the public
// interface (the exported guard functions and the CLI as a subprocess), never
// against internals:
//   AC1 rejection-channels    — a ratchet-next skill missing a rejection-channel
//                               command is reported, naming the exact command.
//   AC2 post-merge-continuation — a ratchet-next skill missing the ff-main /
//                               worktree-remove / next-pick steps is reported.
//   AC3 empty-queue-diagnosis — a ratchet-status skill missing a diagnosis piece
//                               is reported, naming it.
//   AC4 references-discipline — a references/ file that points at another
//                               references/ file, and a SKILL.md that names a
//                               reference with no read-when cue, are reported.
//   The real repo passes all of the above — proving 0143's premise true today.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detailProblems,
  referencesHopProblems,
  unconditionedReferenceRefs,
  allProblems,
} from "./skill-detail.mjs";

const GUARD = fileURLToPath(new URL("./skill-detail.mjs", import.meta.url));
const REPO_SKILLS = fileURLToPath(new URL("../.agents/skills", import.meta.url));

// Canonical detail bodies — the exact commands the guard requires. A fixture
// skill built from these passes; drop a line and the matching test sees the gap.
const FULL_NEXT = `# Ratchet next
## 2A. Advance
\`git fetch origin && git pull --ff-only origin main\`
\`git worktree remove ../wt/issue-<N>\`
Run the loop: pick the top ready, unblocked issue.
## 2B. Rework
- \`gh pr view <N> --json reviewDecision\` is \`CHANGES_REQUESTED\`.
- \`gh pr reopen <N>\` if the branch exists.
- \`gh api repos/{owner}/{repo}/pulls/<N>/comments\`
`;

const FULL_STATUS = `# Ratchet status
- \`state:draft\` issues lack acceptance criteria.
- \`state:blocked\` chains traced to their root.
- \`gh pr list --head ratchet/planning --state open\`
- \`git status --short plan/\`
Recommend the single best next action.
`;

// Build a temp skills root with the two owning skills, optionally mutated.
function makeSkillsRoot({ next = FULL_NEXT, status = FULL_STATUS } = {}) {
  const root = mkdtempSync(join(tmpdir(), "skill-detail-"));
  mkdirSync(join(root, "ratchet-next"), { recursive: true });
  mkdirSync(join(root, "ratchet-status"), { recursive: true });
  writeFileSync(join(root, "ratchet-next", "SKILL.md"), next);
  writeFileSync(join(root, "ratchet-status", "SKILL.md"), status);
  return root;
}

let pass = 0;
function test(name, fn) {
  const root = makeSkillsRoot(fn.setup || {});
  try {
    fn(root);
    console.log(`  ok  ${name}`);
    pass++;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- AC1: rejection-channels -------------------------------------------------
test("AC1 rejection-channels: a missing channel command is reported by name", (root) => {
  // Full fixture is clean.
  assert.deepEqual(detailProblems(root), []);
  // Remove the reopen command; the gap is reported, naming the command.
  writeFileSync(
    join(root, "ratchet-next", "SKILL.md"),
    FULL_NEXT.replace("- `gh pr reopen <N>` if the branch exists.\n", ""),
  );
  const problems = detailProblems(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /rejection-channels/);
  assert.match(problems[0], /gh pr reopen <N>/);
});

// --- AC2: post-merge-continuation --------------------------------------------
test("AC2 post-merge-continuation: a missing continuation step is reported", (root) => {
  writeFileSync(
    join(root, "ratchet-next", "SKILL.md"),
    FULL_NEXT.replace("`git worktree remove ../wt/issue-<N>`\n", ""),
  );
  const problems = detailProblems(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /post-merge-continuation/);
  assert.match(problems[0], /worktree remove/);
});

// --- AC3: empty-queue-diagnosis ----------------------------------------------
test("AC3 empty-queue-diagnosis: a missing diagnosis piece is reported by name", (root) => {
  writeFileSync(
    join(root, "ratchet-status", "SKILL.md"),
    FULL_STATUS.replace("- `git status --short plan/`\n", ""),
  );
  const problems = detailProblems(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /empty-queue-diagnosis/);
  assert.match(problems[0], /uncommitted plan files/);
});

// --- AC4: references/ discipline ---------------------------------------------
test("AC4 references-discipline: second hop and unconditioned reference are reported", (root) => {
  // Clean baseline: no references dirs ⇒ no hop or read-when problems.
  assert.deepEqual(referencesHopProblems(root), []);
  assert.deepEqual(unconditionedReferenceRefs(root), []);

  // A reference file that points at a second reference file ⇒ hop violation.
  mkdirSync(join(root, "ratchet-next", "references"), { recursive: true });
  writeFileSync(
    join(root, "ratchet-next", "references", "a.md"),
    "See references/b.md for more.\n",
  );
  const hops = referencesHopProblems(root);
  assert.equal(hops.length, 1);
  assert.match(hops[0], /points at another references\/ file/);

  // A SKILL.md naming a reference with no read-when cue ⇒ unconditioned ref.
  writeFileSync(
    join(root, "ratchet-status", "SKILL.md"),
    FULL_STATUS + "\nDetail lives in references/deep.md.\n",
  );
  const unconditioned = unconditionedReferenceRefs(root);
  assert.equal(unconditioned.length, 1);
  assert.match(unconditioned[0], /without an explicit read-when condition/);

  // The same reference named with a "when" cue is accepted.
  writeFileSync(
    join(root, "ratchet-status", "SKILL.md"),
    FULL_STATUS + "\nWhen a cycle is suspected, read references/deep.md.\n",
  );
  assert.deepEqual(unconditionedReferenceRefs(root), []);
});

// --- Premise proof: the real repo carries all the detail today ---------------
test("real repo: ratchet-next and ratchet-status carry all owned detail (CLI exits 0)", () => {
  assert.deepEqual(allProblems(REPO_SKILLS), []);
  const cli = spawnSync(process.execPath, [GUARD], {
    encoding: "utf8",
    env: { ...process.env, SKILLS_ROOT: REPO_SKILLS },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /all owned detail present/);
});

console.log(`\nskill-detail: ${pass} tests passed.`);

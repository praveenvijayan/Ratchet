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
  readFileSync,
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

// --- Issue #502: the skills stop claiming human review is the only merge gate.
// Plan 0201 made the merge tiered and 0209 put that in the kernel; these four
// skills still taught the pre-0201 rule as fact. Each block below is named
// after the acceptance criterion it covers and reads the canonical
// `.agents/skills/**` source (the mirrors are checked by skill-parity).

// Read a canonical SKILL.md, whitespace-normalised so a wrapped phrase matches.
const skillText = (skill) =>
  readFileSync(
    fileURLToPath(new URL(`../.agents/skills/${skill}/SKILL.md`, import.meta.url)),
    "utf8",
  ).replace(/\s+/g, " ");

// Slice a markdown section: from its heading to the next heading of the same or
// a shallower level (or the end of the document).
const section = (doc, heading, stopRe) => {
  const start = doc.indexOf(heading);
  assert.ok(start >= 0, `skill must contain the section heading: ${heading}`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(stopRe);
  return (heading + (end === -1 ? rest : rest.slice(0, end))).replace(/\s+/g, " ");
};

// --- Test: "ratchet-next separates the agent ban from the merge gate"
{
  const next = readFileSync(
    fileURLToPath(new URL("../.agents/skills/ratchet-next/SKILL.md", import.meta.url)),
    "utf8",
  );
  const rules = section(next, "## Hard rules", /\n## /);
  // The ban on the agent is unchanged…
  assert.match(rules, /You never merge or approve/, "ratchet-next must still forbid the agent merging or approving");
  // …but it no longer claims the human's merge is the only gate.
  assert.doesNotMatch(rules, /only gate/i, "ratchet-next must not claim the human's merge/review is the only gate");
  assert.match(rules, /`auto-merge`/, "ratchet-next must name the auto-merge workflow as the normal-risk merger");
  assert.match(rules, /no human in the path/i, "ratchet-next must say a normal-risk PR merges with no human in the path");
  assert.match(rules, /`risk:high`/, "ratchet-next must say which PRs still wait for a human");
  // And the advance path keys off the merge event, not off a human acting.
  assert.match(rules, /merge event/i, "ratchet-next must trigger its advance path on the merge event");
  assert.doesNotMatch(rules, /next trigger is the next human decision/i, "ratchet-next must not make the next trigger a human decision");
}

// --- Test: "the herd rules keep the supervisor ban without the only-gate claim"
{
  const herd = skillText("ratchet-herd");
  // The supervisor is still forbidden every write action, in both places.
  assert.match(herd, /supervisor never merges, approves, closes, or labels anything/i, "the herd skill must still say the supervisor never merges, approves, closes, or labels");
  assert.match(herd, /Never merge, approve, close, or label/, "the herd hard rules must still forbid merging, approving, closing, and labelling");
  // Without asserting that a human is the only gate.
  assert.doesNotMatch(herd, /only gate/i, "the herd skill must not claim human review is the only gate");
  assert.match(herd, /`auto-merge`/, "the herd skill must name what does merge a normal-risk PR");
}

// --- Test: "ratchet-status does not report auto-mergeable work as human-blocked"
{
  const status = skillText("ratchet-status");
  // The old blanket diagnosis is gone.
  assert.doesNotMatch(status, /`state:in-review` \(waiting on a human/i, "ratchet-status must not diagnose every in-review issue as waiting on a human");
  // A normal-risk in-review PR is reported as flowing, not blocked.
  assert.match(status, /`auto-merge`/, "ratchet-status must name the auto-merge sweep that takes normal-risk work");
  assert.match(status, /flowing, not blocked/i, "ratchet-status must call a normal-risk in-review PR flowing, not blocked");
  assert.match(status, /never as human-blocked/i, "ratchet-status must forbid reporting auto-mergeable work as human-blocked");
  // And the genuinely human-blocked case is still identified.
  assert.match(status, /`risk:high` PR \*\*is\*\* waiting on a human/i, "ratchet-status must still identify a risk:high PR as waiting on a human");
  assert.match(status, /`CHANGES_REQUESTED`/, "ratchet-status must treat a changes-requested verdict separately");
}

// --- Test: "ratchet-init explains protection without the human-only-way claim"
{
  const init = skillText("ratchet-init");
  assert.doesNotMatch(init, /the human's merge is the only way/i, "ratchet-init must not justify protection as making the human's merge the only way onto main");
  assert.doesNotMatch(init, /the human's merge stays the gate/i, "ratchet-init must not describe the required-PR rule as keeping the human's merge the gate");
  // Protection is explained by what it actually does.
  assert.match(init, /direct pushes/i, "ratchet-init must explain protection as blocking direct pushes to main");
  assert.match(init, /`gates` and `size`/, "ratchet-init must name the gates and size checks protection requires");
  assert.match(init, /automated and human merges alike/i, "ratchet-init must say the requirement binds automated and human merges alike");
}

// --- Test: "the mirrors match the canonical skill sources"
{
  const parity = fileURLToPath(new URL("./skill-parity.mjs", import.meta.url));
  const cli = spawnSync(process.execPath, [parity], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.equal(cli.status, 0, `skill-parity must pass — run ./setup.sh to regenerate the mirrors:\n${cli.stdout}${cli.stderr}`);
}

// --- Test: "every criterion has exactly one test named after it"
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const names = [
    "ratchet-next separates the agent ban from the merge gate",
    "the herd rules keep the supervisor ban without the only-gate claim",
    "ratchet-status does not report auto-mergeable work as human-blocked",
    "ratchet-init explains protection without the human-only-way claim",
    "the mirrors match the canonical skill sources",
    "every criterion has exactly one test named after it",
  ];
  for (const name of names) {
    const hits = (self.match(new RegExp(`--- Test: "${name.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")}"`, "g")) || []).length;
    assert.equal(hits, 1, `expected exactly one test block named "${name}", found ${hits}`);
  }
}

console.log(`\nskill-detail: ${pass} tests passed + 6 tiered-merge criteria.`);

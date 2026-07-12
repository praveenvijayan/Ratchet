#!/usr/bin/env node
// skill-detail.mjs — the guard that keeps the operating-detail AGENTS.md sheds
// alive in the skills that own it. Plan 0143 slims AGENTS.md on the premise
// that `/ratchet-next` and `/ratchet-status` carry the situational detail —
// rework-channel detection, post-merge continuation, empty-queue diagnosis.
// This module makes that premise enforceable: it fails if any owned piece
// disappears from its owning skill, so the manual can shrink without the
// knowledge quietly evaporating.
//
// It also holds the `references/` discipline (issue #339 AC4): a reference file
// never points at another reference file (at most one hop from a SKILL.md), and
// any reference a SKILL.md names must come with an explicit read-when condition
// so a reader knows before opening it whether they need it.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/skill-detail.mjs
// Override the skills root for testing with SKILLS_ROOT=/dir.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The detail each skill must carry, one entry per acceptance criterion. Each
// requirement is a human label plus the substrings that must all appear in the
// owning SKILL.md — the exact commands a reader would otherwise have lost from
// AGENTS.md. Kept as literal substrings (not loose regexes) so the guard breaks
// the moment the real command wording drifts, not just when a topic vanishes.
export const DETAIL_CHECKS = [
  {
    criterion: "rejection-channels",
    skill: "ratchet-next",
    label: "three rejection-channel detection commands",
    requires: [
      { name: "Request Changes review decision", all: ["gh pr view <N> --json reviewDecision", "CHANGES_REQUESTED"] },
      { name: "review line comments via pulls comments API", all: ["pulls/<N>/comments"] },
      { name: "reopen a closed-unmerged PR", all: ["gh pr reopen <N>"] },
    ],
  },
  {
    criterion: "post-merge-continuation",
    skill: "ratchet-next",
    label: "post-merge continuation",
    requires: [
      { name: "fast-forward main in the shared clone", all: ["git pull --ff-only origin main"] },
      { name: "remove the merged issue's worktree", all: ["git worktree remove ../wt/issue-<N>"] },
      { name: "begin the next pick", all: ["pick the top ready"] },
    ],
  },
  {
    criterion: "empty-queue-diagnosis",
    skill: "ratchet-status",
    label: "empty-queue diagnosis",
    requires: [
      { name: "drafts missing acceptance criteria", all: ["state:draft", "acceptance"] },
      { name: "blocked chains traced to their root", all: ["state:blocked", "root"] },
      { name: "unmerged planning PR", all: ["ratchet/planning"] },
      { name: "uncommitted plan files", all: ["git status --short plan/"] },
      { name: "single next action to unblock", all: ["single best next action"] },
    ],
  },
];

function readSkill(skillsRoot, skill) {
  const path = join(skillsRoot, skill, "SKILL.md");
  if (!existsSync(path)) {
    throw new Error(`Skill not found: ${path}. Cannot verify its owned detail.`);
  }
  return readFileSync(path, "utf8");
}

// Every owned-detail requirement that is absent from its owning SKILL.md.
// Empty array ⇒ each skill still carries the detail AGENTS.md delegated to it.
// Messages name the skill, the criterion, and the exact missing piece.
export function detailProblems(skillsRoot) {
  const problems = [];
  for (const check of DETAIL_CHECKS) {
    const text = readSkill(skillsRoot, check.skill);
    for (const req of check.requires) {
      const missing = req.all.filter((needle) => !text.includes(needle));
      if (missing.length > 0) {
        problems.push(
          `${check.skill} (${check.criterion}): missing ${req.name} — expected ${missing
            .map((m) => `"${m}"`)
            .join(", ")}`,
        );
      }
    }
  }
  return problems;
}

// Every skill directory under the root that has a SKILL.md.
function listSkills(skillsRoot) {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(skillsRoot, name, "SKILL.md")))
    .sort();
}

// All markdown files under a skill's references/ directory (empty if none).
function listReferenceFiles(skillsRoot, skill) {
  const dir = join(skillsRoot, skill, "references");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, path: join(dir, f) }));
}

// Reference files that point at another reference file — a second hop. The
// rule is at most one references/ hop from a SKILL.md, so a reference that
// mentions any `references/…` path (its own name aside) is a violation.
export function referencesHopProblems(skillsRoot) {
  const problems = [];
  for (const skill of listSkills(skillsRoot)) {
    for (const ref of listReferenceFiles(skillsRoot, skill)) {
      const text = readFileSync(ref.path, "utf8");
      if (/references\/[\w./-]+\.md/.test(text)) {
        problems.push(
          `${skill}/references/${ref.name}: points at another references/ file — a reference must be at most one hop from a SKILL.md`,
        );
      }
    }
  }
  return problems;
}

// Reference files a SKILL.md names but without an explicit read-when
// condition. A reader must know, from the SKILL.md line that names a reference,
// whether they need to open it — so the line naming `references/foo.md` must
// also carry a "when/if/for" cue. Returns one problem per unconditioned name.
export function unconditionedReferenceRefs(skillsRoot) {
  const problems = [];
  const cue = /\b(when|if|for|before|during|only|see .* to)\b/i;
  for (const skill of listSkills(skillsRoot)) {
    const text = readSkill(skillsRoot, skill);
    for (const line of text.split("\n")) {
      const m = line.match(/references\/([\w.-]+\.md)/);
      if (m && !cue.test(line)) {
        problems.push(
          `${skill}/SKILL.md: names references/${m[1]} without an explicit read-when condition (add a "when/if/for" cue on that line)`,
        );
      }
    }
  }
  return problems;
}

// All problems, in the order the criteria appear: owned-detail gaps first,
// then the references/ discipline.
export function allProblems(skillsRoot) {
  return [
    ...detailProblems(skillsRoot),
    ...referencesHopProblems(skillsRoot),
    ...unconditionedReferenceRefs(skillsRoot),
  ];
}

// --- CLI guard ----------------------------------------------------------
// Runs as a GATES.md gate. Exits non-zero, naming each gap, when a skill loses
// detail AGENTS.md delegated to it or a references/ file breaks the one-hop /
// read-when discipline. Missing skills fail loud, never silent-pass.
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const skillsRoot = process.env.SKILLS_ROOT || ".agents/skills";

  if (!existsSync(skillsRoot)) {
    console.error(`Skills root not found: ${skillsRoot}. Cannot verify owned skill detail.`);
    process.exit(1);
  }

  let problems;
  try {
    problems = allProblems(skillsRoot);
  } catch (e) {
    console.error(`Could not verify skill detail: ${e.message}`);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error(
      `skill-detail: ${problems.length} problem(s) — AGENTS.md must not shed detail its owning skill no longer carries:`,
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log("skill-detail: all owned detail present; references/ discipline holds.");
}

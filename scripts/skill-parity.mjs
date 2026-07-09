#!/usr/bin/env node
// skill-parity.mjs — the guard that keeps every skill invocable on all three
// agents (Claude Code, Codex, Antigravity). A skill can ship usable on one
// agent yet broken on another two ways, and nothing else catches either:
//   1. Its Codex invocation policy `agents/openai.yaml` is missing, so Codex
//      never learns how to invoke it.
//   2. A `setup.sh` mirror (`.claude/skills/<name>/SKILL.md` or
//      `plugin/skills/<name>/SKILL.md`) has drifted from the canonical
//      `.agents/skills/<name>/SKILL.md`, so one agent runs stale instructions.
// This module is the SINGLE definition of "does every skill carry its cross-
// agent parity", imported by its test and run as a gate itself.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/skill-parity.mjs
// Override the inputs for testing with:
//   CANONICAL_DIR=/dir           canonical skills root (default .agents/skills)
//   CLAUDE_SKILLS_DIR=/dir       Claude Code mirror root (default .claude/skills)
//   PLUGIN_SKILLS_DIR=/dir       plugin mirror root      (default plugin/skills)

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The canonical file every mirror must reproduce byte-for-byte, and the Codex
// policy every skill must carry.
const SKILL_FILE = "SKILL.md";
const OPENAI_POLICY = join("agents", "openai.yaml");

// Every skill directory under `canonicalDir`, sorted for stable output. A skill
// is a directory; stray files at the root are ignored.
export function listSkills(canonicalDir) {
  return readdirSync(canonicalDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Skills whose canonical dir lacks `agents/openai.yaml` — the ones Codex cannot
// invoke. Sorted skill names; empty ⇒ every skill carries its Codex policy.
export function skillsMissingOpenaiPolicy(canonicalDir) {
  return listSkills(canonicalDir).filter(
    (skill) => !existsSync(join(canonicalDir, skill, OPENAI_POLICY)),
  );
}

// Every mirror of a canonical SKILL.md that is missing or not byte-identical.
// Returns one `{ skill, path, reason }` per offending mirror so the caller can
// name the exact drifted path, never a generic "a skill is out of sync". A
// canonical skill with no SKILL.md at all is itself reported (`reason:
// "missing-canonical"`) rather than silently skipped. Sorted by skill then path.
export function mirrorMismatches(canonicalDir, mirrorDirs) {
  const problems = [];
  for (const skill of listSkills(canonicalDir)) {
    const canonicalPath = join(canonicalDir, skill, SKILL_FILE);
    if (!existsSync(canonicalPath)) {
      problems.push({ skill, path: canonicalPath, reason: "missing-canonical" });
      continue;
    }
    const canonicalBytes = readFileSync(canonicalPath);
    for (const mirrorDir of mirrorDirs) {
      const mirrorPath = join(mirrorDir, skill, SKILL_FILE);
      if (!existsSync(mirrorPath)) {
        problems.push({ skill, path: mirrorPath, reason: "missing-mirror" });
        continue;
      }
      if (!canonicalBytes.equals(readFileSync(mirrorPath))) {
        problems.push({ skill, path: mirrorPath, reason: "content-differs" });
      }
    }
  }
  return problems;
}

// Human-readable one-liner per parity problem, in the order a report should
// surface them: missing Codex policies first, then each drifted mirror path.
export function parityProblems(canonicalDir, mirrorDirs) {
  const lines = [];
  for (const skill of skillsMissingOpenaiPolicy(canonicalDir)) {
    lines.push(`${skill}: missing Codex policy ${join(canonicalDir, skill, OPENAI_POLICY)}`);
  }
  for (const { skill, path, reason } of mirrorMismatches(canonicalDir, mirrorDirs)) {
    const why =
      reason === "missing-canonical"
        ? "canonical SKILL.md missing"
        : reason === "missing-mirror"
          ? "mirror missing"
          : "mirror differs from canonical";
    lines.push(`${skill}: ${why} at ${path}`);
  }
  return lines;
}

// --- CLI guard ----------------------------------------------------------
// Runs as a GATES.md gate. Exits non-zero, naming each offending skill and the
// exact path, when a skill is missing its Codex policy or a mirror has drifted
// from the canonical SKILL.md — so a skill can't ship broken on one agent.
// Missing inputs fail loud, never silent-pass.
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const canonicalDir = process.env.CANONICAL_DIR || join(".agents", "skills");
  const mirrorDirs = [
    process.env.CLAUDE_SKILLS_DIR || join(".claude", "skills"),
    process.env.PLUGIN_SKILLS_DIR || join("plugin", "skills"),
  ];

  for (const dir of [canonicalDir, ...mirrorDirs]) {
    if (!existsSync(dir)) {
      console.error(`Skills directory not found: ${dir}. Cannot check cross-agent parity.`);
      process.exit(1);
    }
  }

  let problems;
  try {
    problems = parityProblems(canonicalDir, mirrorDirs);
  } catch (e) {
    console.error(`Could not read skill parity inputs: ${e.message}`);
    process.exit(1);
  }

  const total = listSkills(canonicalDir).length;
  if (problems.length > 0) {
    console.error(
      `::error::${problems.length} cross-agent skill parity problem(s):\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\nEvery skill needs agents/openai.yaml and byte-identical .claude + plugin mirrors. ` +
        `Fix the canonical .agents/skills source and re-run setup.sh.`,
    );
    process.exit(1);
  }
  console.log(
    `All ${total} skill(s) carry their Codex policy and byte-identical .claude + plugin mirrors.`,
  );
}

#!/usr/bin/env node
// skill-parity.mjs — the guard that keeps every skill invocable on all three
// agents (Claude Code, Codex, Antigravity), and keeps the plugin's own prose
// from lying about which skills it ships. A skill can ship broken two ways,
// and nothing else catches either:
//   1. Its Codex invocation policy `agents/openai.yaml` is missing, so Codex
//      never learns how to invoke it.
//   2. A `setup.sh` mirror (`.claude/skills/<name>/SKILL.md` or
//      `plugin/skills/<name>/SKILL.md`) has drifted from the canonical
//      `.agents/skills/<name>/SKILL.md`, so one agent runs stale instructions.
// A third drift is prose, not files: `plugin/.claude-plugin/plugin.json` and
// `.claude-plugin/marketplace.json` each carry a hand-written `description`
// that can enumerate a subset of skill names — accurate the day it's written,
// stale the next time a skill is added (#261). This module treats naming SOME
// but not ALL skills as that drift; naming none (a generic description) or
// naming every skill (a complete enumeration) are both fine.
// This module is the SINGLE definition of "does every skill carry its cross-
// agent parity, and does the plugin's own prose match its skill set",
// imported by its test and run as a gate itself.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/skill-parity.mjs
// Override the inputs for testing with:
//   CANONICAL_DIR=/dir           canonical skills root (default .agents/skills)
//   CLAUDE_SKILLS_DIR=/dir       Claude Code mirror root (default .claude/skills)
//   PLUGIN_SKILLS_DIR=/dir       plugin mirror root      (default plugin/skills)
//   PLUGIN_JSON=/file            plugin.json path        (default plugin/.claude-plugin/plugin.json)
//   MARKETPLACE_JSON=/file       marketplace.json path    (default .claude-plugin/marketplace.json)

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

// Which of `skills` are named (as an exact-name substring) inside `description`.
// A skill counts as mentioned only by its full directory name, so `ratchet-plan`
// never falsely matches on a loose word like "plan".
export function mentionedSkills(description, skills) {
  return skills.filter((skill) => description.includes(skill));
}

// Read the plugin's two hand-written descriptions: `plugin.json`'s top-level
// `description` and the `ratchet` entry's `description` in `marketplace.json`.
// Returns `[{ file, description }, ...]`. Throws a plain Error naming the file
// and the missing piece — never a bare JSON.parse crash — when a file is
// unreadable, not JSON, or lacks the expected field.
export function readPluginDescriptions({
  pluginJsonPath = join("plugin", ".claude-plugin", "plugin.json"),
  marketplaceJsonPath = join(".claude-plugin", "marketplace.json"),
} = {}) {
  const readJson = (path) => {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`${path}: ${e.code === "ENOENT" ? "file not found" : e.message}`);
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${path}: not valid JSON (${e.message})`);
    }
  };

  const plugin = readJson(pluginJsonPath);
  if (typeof plugin.description !== "string") {
    throw new Error(`${pluginJsonPath}: missing a string "description" field`);
  }

  const marketplace = readJson(marketplaceJsonPath);
  const entry = (marketplace.plugins || []).find((p) => p.name === "ratchet");
  if (!entry || typeof entry.description !== "string") {
    throw new Error(`${marketplaceJsonPath}: missing the "ratchet" plugin entry's "description" field`);
  }

  return [
    { file: pluginJsonPath, description: plugin.description },
    { file: marketplaceJsonPath, description: entry.description },
  ];
}

// One human-readable line per plugin-description problem: a location naming
// some but not all of `skills` (a stale partial enumeration), or the two
// locations disagreeing outright. Empty ⇒ both descriptions are clean.
export function descriptionProblems(skills, locations) {
  const problems = [];
  for (const loc of locations) {
    const mentioned = mentionedSkills(loc.description, skills);
    if (mentioned.length > 0 && mentioned.length < skills.length) {
      const missing = skills.filter((s) => !mentioned.includes(s));
      problems.push(
        `${loc.file}: description names ${mentioned.join(", ")} but not ${missing.join(", ")} — ` +
          `characterize the full skill set generically, or name every skill`,
      );
    }
  }
  const distinct = new Set(locations.map((l) => l.description));
  if (distinct.size > 1) {
    problems.push(
      `plugin descriptions disagree: ${locations.map((l) => `${l.file}=${JSON.stringify(l.description)}`).join(" vs ")}`,
    );
  }
  return problems;
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

  const skills = listSkills(canonicalDir);
  let descProblems;
  try {
    const locations = readPluginDescriptions({
      pluginJsonPath: process.env.PLUGIN_JSON || join("plugin", ".claude-plugin", "plugin.json"),
      marketplaceJsonPath: process.env.MARKETPLACE_JSON || join(".claude-plugin", "marketplace.json"),
    });
    descProblems = descriptionProblems(skills, locations);
  } catch (e) {
    console.error(`Could not read plugin descriptions: ${e.message}`);
    process.exit(1);
  }

  const allProblems = [...problems, ...descProblems];
  if (allProblems.length > 0) {
    console.error(
      `::error::${allProblems.length} skill parity problem(s):\n` +
        allProblems.map((p) => `  - ${p}`).join("\n") +
        `\nEvery skill needs agents/openai.yaml and byte-identical .claude + plugin mirrors, and the ` +
        `plugin description must never name a stale subset of skills. ` +
        `Fix the canonical .agents/skills source (and re-run setup.sh) or the plugin description.`,
    );
    process.exit(1);
  }
  console.log(
    `All ${skills.length} skill(s) carry their Codex policy and byte-identical .claude + plugin mirrors, ` +
      `and the plugin descriptions name no stale subset of skills.`,
  );
}

#!/usr/bin/env node
// state-instructions-symmetry.test.mjs — behaviour test for issue #213.
// Zero dependencies. Run:  node scripts/state-instructions-symmetry.test.mjs
//
// Acceptance criteria of #213 (one test each, named after the criterion):
//   1. Every instruction that sets a state:* label (AGENTS.md, workflow
//      prompts, skills) states the removal of the previous state label in the
//      same step, symmetric with the existing exit-path wording.
//   2. Every criterion above has exactly one test named after it.
//
// The check reads the instruction sources as their consumers do — as prose —
// and asserts that every imperative moving an issue INTO a state:* label also
// names a removal within the same step. Descriptive mentions of a label
// ("flips ... to state:ready", "the next state:ready issue") are deliberately
// not matched: only imperatives that a worker executes are transitions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// The instruction sources the criterion names: the manual, the unattended-run
// workflow prompt, and the skill (canonical source plus its two mirrors).
const SOURCES = [
  "../AGENTS.md",
  "../.github/workflows/ratchet-run.yml",
  "../.agents/skills/ratchet-next/SKILL.md",
  "../.claude/skills/ratchet-next/SKILL.md",
  "../plugin/skills/ratchet-next/SKILL.md",
];

// An imperative that moves an issue INTO a state:* label — the only construct
// the criterion governs.
const SET_COMMAND = /(?:set label|Set the issue(?: back)? to|reset it to)\s+`?state:[a-z-]+`?/gi;

// --- #213 criterion 1: every state-setting instruction removes the previous
// label in the same step. ---
{
  const offenders = [];
  for (const rel of SOURCES) {
    const text = read(rel).replace(/\s+/g, " ");
    for (const m of text.matchAll(SET_COMMAND)) {
      // The "same step" is the imperative plus the clause that follows it, up
      // to the next sentence boundary or numbered step.
      const step = text.slice(m.index, m.index + 200).split(/(?<=\.)\s|\s\d+\.\s/)[0];
      if (!/remov/i.test(step)) {
        offenders.push(`${rel}: "${m[0]}" states no removal of the previous label in the same step`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `every state-setting instruction must remove the previous label in the same step:\n${offenders.join("\n")}`,
  );
}

// --- #213 criterion 2: every criterion above has exactly one test named after
// it. ---
{
  const self = read("./state-instructions-symmetry.test.mjs");
  for (const c of ["criterion 1", "criterion 2"]) {
    const hits = (self.match(new RegExp(`#213 ${c}:`, "g")) || []).length;
    assert.equal(hits, 1, `#213 ${c} must have exactly one test named after it`);
  }
}

console.log("PASS state-instructions-symmetry.test.mjs (2 criteria)");

#!/usr/bin/env node
// skill-parity.test.mjs — behaviour tests for the cross-agent skill parity
// guard. Zero dependencies. Run:  node scripts/skill-parity.test.mjs
//
// One test per acceptance criterion of issue #119, exercised through the public
// interface (the exported guard functions and the CLI as a subprocess), never
// against internals:
//   1. A skill dir with a SKILL.md but no agents/openai.yaml is reported by name.
//   2. A mirror whose SKILL.md differs from canonical by one byte is reported
//      by its exact path (missing mirrors too), not a generic failure.
//   3. A fully consistent skill set exits zero — and so does this real repo,
//      confirming ratchet-herd ships with its openai.yaml and both mirrors.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listSkills,
  skillsMissingOpenaiPolicy,
  mirrorMismatches,
  parityProblems,
} from "./skill-parity.mjs";

// fileURLToPath (not url.pathname) so a repo path containing spaces resolves to
// a real filename rather than a percent-encoded one node can't open.
const GUARD = fileURLToPath(new URL("./skill-parity.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const canonicalRepo = join(repoRoot, ".agents", "skills");
const claudeRepo = join(repoRoot, ".claude", "skills");
const pluginRepo = join(repoRoot, "plugin", "skills");

// Run the guard CLI against given skill roots, returning exit status + output.
function runGuard(env) {
  const res = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status, out: (res.stdout || "") + (res.stderr || "") };
}

// Build a throwaway skill tree. `skills` maps name → { openai, skill, mirrors }
// where `skill` is the canonical SKILL.md body, `openai` toggles the Codex
// policy, and `mirrors` maps mirrorRootName → body (undefined ⇒ omit that
// mirror file). Returns { canonicalDir, mirrorDirs, env }.
async function makeTree(skills) {
  const dir = await mkdtemp(join(tmpdir(), "skill-parity-"));
  const canonicalDir = join(dir, "agents-skills");
  const claudeDir = join(dir, "claude-skills");
  const pluginDir = join(dir, "plugin-skills");
  const mirrorRoots = { claude: claudeDir, plugin: pluginDir };

  for (const [name, spec] of Object.entries(skills)) {
    const home = join(canonicalDir, name);
    await mkdir(join(home, "agents"), { recursive: true });
    if (spec.skill !== undefined) await writeFile(join(home, "SKILL.md"), spec.skill);
    if (spec.openai !== false) await writeFile(join(home, "agents", "openai.yaml"), "policy\n");
    for (const [root, body] of Object.entries(spec.mirrors || {})) {
      if (body === undefined) continue;
      await mkdir(join(mirrorRoots[root], name), { recursive: true });
      await writeFile(join(mirrorRoots[root], name, "SKILL.md"), body);
    }
  }
  return {
    canonicalDir,
    mirrorDirs: [claudeDir, pluginDir],
    env: { CANONICAL_DIR: canonicalDir, CLAUDE_SKILLS_DIR: claudeDir, PLUGIN_SKILLS_DIR: pluginDir },
  };
}

// A skill wired up correctly on all three agents.
const consistent = (body = "# skill\n") => ({
  skill: body,
  openai: true,
  mirrors: { claude: body, plugin: body },
});

// --- Criterion 1: a skill missing agents/openai.yaml is named ------------
{
  const { canonicalDir, mirrorDirs, env } = await makeTree({
    good: consistent(),
    "no-codex": { ...consistent(), openai: false },
  });

  assert.deepEqual(
    skillsMissingOpenaiPolicy(canonicalDir),
    ["no-codex"],
    "the guard must name exactly the skill lacking agents/openai.yaml",
  );
  // No mirror drift here, so the only parity problem is the missing policy.
  assert.deepEqual(mirrorMismatches(canonicalDir, mirrorDirs), []);

  const red = runGuard(env);
  assert.notEqual(red.status, 0, "a missing Codex policy must make the guard exit non-zero");
  assert.ok(red.out.includes("no-codex"), "the red guard must name the offending skill");
  assert.ok(red.out.includes("openai.yaml"), "the red guard must name the missing policy file");
}

// --- Criterion 2: a one-byte mirror drift is reported by exact path -------
{
  const canonicalBody = "# ratchet-herd\nrun the fleet.\n";
  const drifted = canonicalBody.replace("fleet.", "fleet");
  const { canonicalDir, mirrorDirs, env } = await makeTree({
    "ratchet-herd": {
      skill: canonicalBody,
      openai: true,
      mirrors: { claude: canonicalBody, plugin: drifted }, // plugin differs by one byte
    },
  });

  const mismatches = mirrorMismatches(canonicalDir, mirrorDirs);
  assert.equal(mismatches.length, 1, "only the drifted mirror is a problem");
  assert.equal(mismatches[0].reason, "content-differs");
  assert.ok(
    mismatches[0].path.includes(join("plugin-skills", "ratchet-herd", "SKILL.md")),
    "the guard must point at the exact drifted mirror path, not a generic failure",
  );

  const red = runGuard(env);
  assert.notEqual(red.status, 0, "a drifted mirror must make the guard exit non-zero");
  assert.ok(red.out.includes("ratchet-herd"), "the red guard must name the skill");
  assert.ok(
    red.out.includes(join("plugin-skills", "ratchet-herd", "SKILL.md")),
    "the red guard must print the exact mismatched path",
  );

  // A missing mirror file is caught the same way as a drifted one.
  const missing = await makeTree({
    solo: { skill: canonicalBody, openai: true, mirrors: { claude: canonicalBody } }, // plugin absent
  });
  const missMirror = mirrorMismatches(missing.canonicalDir, missing.mirrorDirs);
  assert.deepEqual(missMirror.map((m) => m.reason), ["missing-mirror"]);
  assert.notEqual(runGuard(missing.env).status, 0, "a missing mirror must fail the guard too");
}

// --- Criterion 3: a fully consistent set exits zero ----------------------
{
  const { canonicalDir, mirrorDirs, env } = await makeTree({
    alpha: consistent("# alpha\n"),
    beta: consistent("# beta\n"),
  });
  assert.deepEqual(skillsMissingOpenaiPolicy(canonicalDir), []);
  assert.deepEqual(mirrorMismatches(canonicalDir, mirrorDirs), []);
  assert.deepEqual(parityProblems(canonicalDir, mirrorDirs), []);

  const green = runGuard(env);
  assert.equal(green.status, 0, `a consistent skill set must exit zero (out: ${green.out})`);
}

// --- Criterion 3 (real tree): ratchet-herd + every skill ship in parity ---
{
  assert.ok(listSkills(canonicalRepo).includes("ratchet-herd"), "ratchet-herd must be a skill");
  assert.deepEqual(
    parityProblems(canonicalRepo, [claudeRepo, pluginRepo]),
    [],
    "this repo must already satisfy cross-agent skill parity for every skill",
  );
  const { status, out } = runGuard({
    CANONICAL_DIR: canonicalRepo,
    CLAUDE_SKILLS_DIR: claudeRepo,
    PLUGIN_SKILLS_DIR: pluginRepo,
  });
  assert.equal(status, 0, `the guard must pass against this repo (out: ${out})`);
  assert.ok(/carry their Codex policy/i.test(out), "the guard reports the skills it verified");
}

console.log("PASS skill-parity.test.mjs (3 criteria, guard verified against repo and fixtures)");

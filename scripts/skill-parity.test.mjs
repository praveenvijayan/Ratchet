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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import {
  listSkills,
  skillsMissingOpenaiPolicy,
  mirrorMismatches,
  parityProblems,
  mentionedSkills,
  readPluginDescriptions,
  descriptionProblems,
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

// --- #261 Criterion 1: plugin.json no longer names a stale subset of skills
{
  const skills = listSkills(canonicalRepo);
  assert.ok(skills.length >= 3, "sanity: the real repo ships more than a handful of skills");
  const locations = readPluginDescriptions();
  const pluginEntry = locations.find((l) => l.file.endsWith("plugin.json"));
  const mentioned = mentionedSkills(pluginEntry.description, skills);
  assert.ok(
    mentioned.length === 0 || mentioned.length === skills.length,
    `plugin.json must name no skills or every skill, not a stale subset; mentions: ${mentioned}`,
  );
  assert.deepEqual(descriptionProblems(skills, locations), [], "the real repo's descriptions must be clean");
}

// --- #261 Criterion 2: marketplace.json entry is consistent with plugin.json
{
  const skills = listSkills(canonicalRepo);
  const locations = readPluginDescriptions();
  const distinct = new Set(locations.map((l) => l.description));
  assert.equal(distinct.size, 1, "plugin.json and marketplace.json descriptions must be identical");

  const green = spawnSync("node", [GUARD], { encoding: "utf8", cwd: repoRoot });
  assert.equal(green.status, 0, `the real repo tree must pass the guard, got: ${green.out || green.stderr}`);
}

// --- #261 Criterion 3: a stale-subset description fails the gate, naming the
// offending file and the skill(s) it leaves out; a full enumeration or a
// generic description both pass; disagreeing descriptions fail too.
{
  const fixtures = [];
  const makeFixture = ({ skills, pluginDescription, marketplaceDescription }) => {
    const dir = mkdtempSync(join(tmpdir(), "skill-parity-desc-"));
    fixtures.push(dir);
    for (const skill of skills) mkdirSync(join(dir, "agents-skills", skill, "agents"), { recursive: true });
    for (const skill of skills) writeFileSync(join(dir, "agents-skills", skill, "agents", "openai.yaml"), "policy\n");
    for (const skill of skills) writeFileSync(join(dir, "agents-skills", skill, "SKILL.md"), `# ${skill}\n`);
    mkdirSync(join(dir, "plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, "plugin", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ratchet", description: pluginDescription }, null, 2) + "\n",
    );
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "marketplace.json"),
      JSON.stringify(
        { name: "ratchet", plugins: [{ name: "ratchet", source: "./plugin", description: marketplaceDescription }] },
        null,
        2,
      ) + "\n",
    );
    return dir;
  };
  const runGuardIn = (dir) =>
    spawnSync("node", [GUARD], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, CANONICAL_DIR: join(dir, "agents-skills"), CLAUDE_SKILLS_DIR: join(dir, "agents-skills"), PLUGIN_SKILLS_DIR: join(dir, "agents-skills") },
    });

  const staleDir = makeFixture({
    skills: ["ratchet-plan", "ratchet-sync", "ratchet-init", "ratchet-map"],
    pluginDescription: "Ratchet: ratchet-plan, ratchet-sync, and ratchet-init skills.",
    marketplaceDescription: "Ratchet: ratchet-plan, ratchet-sync, and ratchet-init skills.",
  });
  const staleLocations = readPluginDescriptions({
    pluginJsonPath: join(staleDir, "plugin", ".claude-plugin", "plugin.json"),
    marketplaceJsonPath: join(staleDir, ".claude-plugin", "marketplace.json"),
  });
  const staleProblems = descriptionProblems(["ratchet-plan", "ratchet-sync", "ratchet-init", "ratchet-map"], staleLocations);
  assert.equal(staleProblems.length, 2, "both files name the same stale 3-of-4 subset, one problem per file");
  assert.ok(staleProblems.every((p) => p.includes("ratchet-map")), "names the skill left out");

  const staleRed = runGuardIn(staleDir);
  assert.notEqual(staleRed.status, 0, "a stale-subset description must fail the guard");
  assert.ok((staleRed.stdout + staleRed.stderr).includes("ratchet-map"), "the guard names the missing skill");

  const fullDir = makeFixture({
    skills: ["ratchet-plan", "ratchet-sync", "ratchet-init"],
    pluginDescription: "Ratchet: ratchet-plan, ratchet-sync, and ratchet-init skills.",
    marketplaceDescription: "Ratchet: ratchet-plan, ratchet-sync, and ratchet-init skills.",
  });
  assert.equal(runGuardIn(fullDir).status, 0, "naming every skill is a valid, non-stale enumeration");

  const genericDir = makeFixture({
    skills: ["ratchet-plan", "ratchet-sync", "ratchet-init"],
    pluginDescription: "Ratchet: the full skill set for the delivery loop.",
    marketplaceDescription: "Ratchet: the full skill set for the delivery loop.",
  });
  assert.equal(runGuardIn(genericDir).status, 0, "a generic description mentioning no skill names must pass");

  const mismatchDir = makeFixture({
    skills: ["ratchet-plan"],
    pluginDescription: "Ratchet: the full skill set.",
    marketplaceDescription: "Ratchet: a different description.",
  });
  assert.notEqual(runGuardIn(mismatchDir).status, 0, "disagreeing descriptions must fail the guard");

  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
}

// --- #261 Criterion 4: each criterion above has exactly one test (meta) ---
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (let n = 1; n <= 4; n++) {
    const hits = (self.match(new RegExp(`--- #261 Criterion ${n}:`, "g")) || []).length;
    assert.equal(hits, 1, `expected exactly one "#261 Criterion ${n}" test block, found ${hits}`);
  }
}

console.log("PASS skill-parity.test.mjs (3 skill-parity criteria + 4 #261 plugin-description criteria)");

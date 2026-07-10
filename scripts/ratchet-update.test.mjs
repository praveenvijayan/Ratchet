#!/usr/bin/env node
// ratchet-update.test.mjs — one test per acceptance criterion of issue #240
// (plan 0107-manifest-aware-update, narrowed to selection). Drives the real
// scripts/ratchet-update.sh against a local fixture remote (a tagged git repo
// carrying a ratchet-manifest.json) — the true fetch->select->checkout path.
//   1. A core-only install refreshes exactly the core-profile framework files
//      at the target version — no optional-profile files, no excluded files.
//   2. `generated` paths are left byte-for-byte unchanged by an update.
//   3. A successful update bumps both .ratchet-version and the installation
//      manifest's recorded version.
// Zero dependencies. Run: node scripts/ratchet-update.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // scripts/
const SCRIPT = join(here, "ratchet-update.sh");
const SELF = fileURLToPath(import.meta.url);

const dirs = [];
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const write = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

// A fixture "Ratchet release": a git repo with a manifest + files, tagged.
function makeRelease({ manifest, files, tag }) {
  const dir = tmp("update-release-");
  writeFileSync(join(dir, "ratchet-manifest.json"), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git(dir, "init", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", `release ${tag}`);
  git(dir, "tag", tag);
  return dir;
}

// A consumer repo carrying a prior install.
function makeConsumer({ install, seed = {} }) {
  const dir = tmp("update-consumer-");
  git(dir, "init", "-b", "main");
  write(dir, "scripts/ratchet-update.sh", readFileSync(SCRIPT, "utf8"));
  chmodSync(join(dir, "scripts", "ratchet-update.sh"), 0o755);
  write(dir, ".ratchet-install.json", JSON.stringify(install, null, 2));
  for (const [rel, body] of Object.entries(seed)) write(dir, rel, body);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "consumer");
  return dir;
}

function runUpdate(consumer, remote, ref) {
  const res = spawnSync("bash", ["scripts/ratchet-update.sh", ref], {
    cwd: consumer,
    env: { ...process.env, RATCHET_REMOTE: remote },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

// A core + optional-profile release, plus a generated path and an excluded test file.
const CORE_AGENTS_V1 = "AGENTS v1\n";
const CORE_PLAN_SYNC_V1 = "// plan-sync v1\n";
function stdRelease(tag, version) {
  return makeRelease({
    tag,
    manifest: {
      profiles: { core: "base", optional: "extra" },
      files: [
        { path: "AGENTS.md", class: "framework", profile: "core" },
        { path: "scripts/plan-sync.mjs", class: "framework", profile: "core" },
        { path: "scripts/optional-tool.mjs", class: "framework", profile: "optional" },
        { path: "scripts/optional-tool.test.mjs", class: "excluded" },
        { path: "GATES.md", class: "generated" },
      ],
    },
    files: {
      "AGENTS.md": CORE_AGENTS_V1,
      "scripts/plan-sync.mjs": CORE_PLAN_SYNC_V1,
      "scripts/optional-tool.mjs": "// optional\n",
      "scripts/optional-tool.test.mjs": "// test\n",
      "GATES.md": "released GATES\n",
      ".ratchet-version": version ? `${version}\n` : undefined,
    },
  });
}

// --- Criterion 1: a core-only install refreshes exactly the core files ------
{
  const release = stdRelease("v2.0.0", "2.0.0");
  const consumer = makeConsumer({
    install: { version: "1.0.0", profiles: ["core"] },
    seed: { "AGENTS.md": "AGENTS v0\n", "scripts/plan-sync.mjs": "// plan-sync v0\n", "GATES.md": "host GATES\n" },
  });
  const r = runUpdate(consumer, release, "v2.0.0");
  assert.equal(r.status, 0, `update should succeed: ${r.out}`);
  assert.equal(readFileSync(join(consumer, "AGENTS.md"), "utf8"), CORE_AGENTS_V1, "core file refreshed to target version");
  assert.equal(readFileSync(join(consumer, "scripts/plan-sync.mjs"), "utf8"), CORE_PLAN_SYNC_V1, "core script refreshed");
  assert.ok(!existsSync(join(consumer, "scripts/optional-tool.mjs")), "optional-profile file is not pulled");
  assert.ok(!existsSync(join(consumer, "scripts/optional-tool.test.mjs")), "excluded test file is not pulled");
}

// --- Criterion 2: `generated` paths are left byte-for-byte unchanged --------
{
  const release = stdRelease("v2.1.0", "2.1.0");
  const consumer = makeConsumer({
    install: { version: "1.0.0", profiles: ["core"] },
    seed: { "AGENTS.md": "AGENTS v0\n", "GATES.md": "host-owned GATES, never touched\n" },
  });
  const r = runUpdate(consumer, release, "v2.1.0");
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(consumer, "GATES.md"), "utf8"), "host-owned GATES, never touched\n", "generated GATES.md is untouched");
}

// --- Criterion 3: a successful update bumps both version records -----------
{
  const release = stdRelease("v3.0.0", "3.0.0");
  const consumer = makeConsumer({ install: { version: "1.0.0", profiles: ["core"] } });
  const r = runUpdate(consumer, release, "v3.0.0");
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(consumer, ".ratchet-version"), "utf8"), "3.0.0\n");
  const install = JSON.parse(readFileSync(join(consumer, ".ratchet-install.json"), "utf8"));
  assert.equal(install.version, "3.0.0", "installation manifest records the new version");
}

// --- Meta: exactly one test block per criterion ------------------------------
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 1; n <= 3; n++) {
    const hits = src.match(new RegExp(`--- Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "Criterion ${n}" block, found ${hits.length}`);
  }
}

for (const d of dirs) { spawnSync("rm", ["-rf", d]); }
console.log("PASS ratchet-update.test.mjs (3 criteria, end-to-end)");

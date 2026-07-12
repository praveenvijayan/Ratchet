#!/usr/bin/env node
// ratchet-update.test.mjs — one test per acceptance criterion of issue #240
// (plan 0107-manifest-aware-update, narrowed to selection) and issue #250
// (plan 0111-updater-modified-file-protection). Drives the real
// scripts/ratchet-update.sh against a local fixture remote (a tagged git repo
// carrying a ratchet-manifest.json) — the true fetch->select->checkout path.
//   1. A core-only install refreshes exactly the core-profile framework files
//      at the target version — no optional-profile files, no excluded files.
//   2. `generated` paths are left byte-for-byte unchanged by an update.
//   3. A successful update bumps both .ratchet-version and the installation
//      manifest's recorded version.
//   4. A locally modified framework file is not silently overwritten; it is
//      listed and requires --force to replace.
//   5. --force replaces listed modified files and reports each replacement.
//   6. Install/update records a content hash for every installed framework
//      file, so a later run can detect local modification.
//   7. No .ratchet-install.json AND no .ratchet-version fails clearly, naming
//      the reinstall command, and leaves the project unchanged.
// Plus issue #398 (plan 0166-update-adopt-missing-install-record):
//   8.  Missing install record but a readable .ratchet-version → adoption
//       reconstructs a valid record (profiles, per-file hashes, recorded
//       version) from the pinned release, no full reinstall.
//   9.  Adoption never destroys local changes: a file differing from the
//       recorded release is reported and left byte-for-byte untouched.
//   10. After adoption, ratchet-update runs to completion in the same repo.
//   11. Adoption that cannot proceed names the exact reinstall command,
//       never a stack trace.
//   12. Exactly one test block per criterion.
// Zero dependencies. Run: node scripts/ratchet-update.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const noStack = (out) => assert.ok(!/\n\s+at\s+\S+:\d+/.test(out), "no stack trace in output");

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

// A consumer repo carrying a prior install (or none, for the missing-manifest test).
function makeConsumer({ install, seed = {} } = {}) {
  const dir = tmp("update-consumer-");
  git(dir, "init", "-b", "main");
  write(dir, "scripts/ratchet-update.sh", readFileSync(SCRIPT, "utf8"));
  chmodSync(join(dir, "scripts", "ratchet-update.sh"), 0o755);
  if (install) write(dir, ".ratchet-install.json", JSON.stringify(install, null, 2));
  for (const [rel, body] of Object.entries(seed)) write(dir, rel, body);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "consumer");
  return dir;
}

function runUpdate(consumer, remote, args) {
  const res = spawnSync("bash", ["scripts/ratchet-update.sh", ...(Array.isArray(args) ? args : [args])], {
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

// --- Criterion 4: a locally modified framework file blocks the update -------
{
  const release = stdRelease("v4.0.0", "4.0.0");
  const priorHash = sha256(Buffer.from("AGENTS v0\n"));
  const consumer = makeConsumer({
    install: { version: "1.0.0", profiles: ["core"], hashes: { "AGENTS.md": priorHash } },
    seed: { "AGENTS.md": "AGENTS v0 BUT HOST EDITED THIS\n" },
  });
  const blocked = runUpdate(consumer, release, ["v4.0.0"]);
  assert.notEqual(blocked.status, 0, "a locally modified framework file must block the update");
  assert.ok(/modified:\s*AGENTS\.md/.test(blocked.out), "lists the modified path");
  assert.equal(readFileSync(join(consumer, "AGENTS.md"), "utf8"), "AGENTS v0 BUT HOST EDITED THIS\n", "the host's edit survives");
  assert.ok(!existsSync(join(consumer, ".ratchet-version")), "no version file written on abort");
}

// --- Criterion 5: --force replaces modified files and reports each ----------
{
  const release = stdRelease("v4.1.0", "4.1.0");
  const priorHash = sha256(Buffer.from("AGENTS v0\n"));
  const consumer = makeConsumer({
    install: { version: "1.0.0", profiles: ["core"], hashes: { "AGENTS.md": priorHash } },
    seed: { "AGENTS.md": "AGENTS v0 BUT HOST EDITED THIS\n" },
  });
  const forced = runUpdate(consumer, release, ["v4.1.0", "--force"]);
  assert.equal(forced.status, 0, `--force must replace it: ${forced.out}`);
  assert.equal(readFileSync(join(consumer, "AGENTS.md"), "utf8"), CORE_AGENTS_V1, "--force overwrites the modified file");
  assert.ok(/replaced \(--force\):\s*AGENTS\.md/.test(forced.out), "reports the forced replacement");
}

// --- Criterion 6: a hash is recorded for every installed framework file -----
{
  const release = stdRelease("v4.2.0", "4.2.0");
  const consumer = makeConsumer({ install: { version: "1.0.0", profiles: ["core"] } });
  const r = runUpdate(consumer, release, ["v4.2.0"]);
  assert.equal(r.status, 0, r.out);
  const install = JSON.parse(readFileSync(join(consumer, ".ratchet-install.json"), "utf8"));
  assert.equal(install.hashes["AGENTS.md"], sha256(Buffer.from(CORE_AGENTS_V1)), "hash recorded for AGENTS.md");
  assert.equal(install.hashes["scripts/plan-sync.mjs"], sha256(Buffer.from(CORE_PLAN_SYNC_V1)), "hash recorded for plan-sync.mjs");
}

// --- Criterion 7: no .ratchet-install.json fails clearly, unchanged ---------
{
  const release = stdRelease("v5.0.0", "5.0.0");
  const consumer = makeConsumer({ seed: { "README.md": "legacy install\n" } });
  const before = readdirSync(consumer).sort();
  const r = runUpdate(consumer, release, ["v5.0.0"]);
  assert.notEqual(r.status, 0, "a project with no installation manifest must fail");
  assert.ok(/\.ratchet-install\.json/.test(r.out), "names the missing manifest file");
  assert.ok(/bootstrap/.test(r.out), "points at scripts/bootstrap.sh to adopt manifest tracking");
  noStack(r.out);
  assert.deepEqual(readdirSync(consumer).sort(), before, "project tree is left unchanged");
}

// A remote carrying several tagged releases in one history, so adoption can
// resolve a RECORDED version distinct from the update target.
function makeReleaseSeq(steps) {
  const dir = tmp("update-release-");
  git(dir, "init", "-b", "main");
  for (const { tag, manifest, files } of steps) {
    writeFileSync(join(dir, "ratchet-manifest.json"), JSON.stringify(manifest));
    for (const [rel, body] of Object.entries(files)) if (body !== undefined) write(dir, rel, body);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", `release ${tag}`);
    git(dir, "tag", tag);
  }
  return dir;
}

// --- Issue #398: adopting an install that has no .ratchet-install.json --------
// A repo that got Ratchet by direct copy has framework files + .ratchet-version
// but no install record. The updater reconstructs the record from the recorded
// release rather than demanding a full reinstall.

// --- Criterion 8: adoption writes a valid record (profiles, per-file hashes,
//     recorded version) without a full reinstall ------------------------------
{
  const release = stdRelease("v1.0.0", "1.0.0"); // core + optional profiles
  const consumer = makeConsumer({
    // no install record — the direct-copy case
    seed: {
      "AGENTS.md": CORE_AGENTS_V1,
      "scripts/plan-sync.mjs": CORE_PLAN_SYNC_V1,
      "scripts/optional-tool.mjs": "// optional\n", // optional profile present on disk
      "GATES.md": "host GATES\n",
      ".ratchet-version": "1.0.0\n",
    },
  });
  const r = runUpdate(consumer, release, ["v1.0.0"]);
  assert.equal(r.status, 0, `adoption + update should succeed: ${r.out}`);
  assert.ok(existsSync(join(consumer, ".ratchet-install.json")), "adoption writes the install record");
  const install = JSON.parse(readFileSync(join(consumer, ".ratchet-install.json"), "utf8"));
  assert.equal(install.version, "1.0.0", "record carries the recorded version");
  assert.ok(install.profiles.includes("core") && install.profiles.includes("optional"), "detects the installed profiles from disk");
  assert.equal(install.hashes["AGENTS.md"], sha256(Buffer.from(CORE_AGENTS_V1)), "records pristine hash for a core file");
  assert.equal(install.hashes["scripts/plan-sync.mjs"], sha256(Buffer.from(CORE_PLAN_SYNC_V1)), "records pristine hash for a core script");
  assert.equal(install.hashes["scripts/optional-tool.mjs"], sha256(Buffer.from("// optional\n")), "records pristine hash for an optional-profile file");
  assert.ok(!existsSync(join(consumer, "scripts/optional-tool.test.mjs")), "no full reinstall — excluded files are not pulled");
}

// --- Criterion 9: adoption never destroys local changes — a file differing
//     from the recorded release is reported and left byte-for-byte untouched --
{
  const release = stdRelease("v1.0.0", "1.0.0");
  const hostEdited = "AGENTS v1 BUT HOST EDITED THIS\n";
  const consumer = makeConsumer({
    seed: {
      "AGENTS.md": hostEdited, // differs from the pristine v1.0.0 release
      "scripts/plan-sync.mjs": CORE_PLAN_SYNC_V1,
      ".ratchet-version": "1.0.0\n",
    },
  });
  const r = runUpdate(consumer, release, ["v1.0.0"]);
  assert.equal(readFileSync(join(consumer, "AGENTS.md"), "utf8"), hostEdited, "the host's edit is left byte-for-byte untouched");
  assert.ok(/AGENTS\.md/.test(r.out), "the modified path is reported to the user");
  const install = JSON.parse(readFileSync(join(consumer, ".ratchet-install.json"), "utf8"));
  assert.equal(install.hashes["AGENTS.md"], sha256(Buffer.from(CORE_AGENTS_V1)), "adoption records the PRISTINE hash, so future runs keep detecting the local edit");
}

// --- Criterion 10: after adoption, ratchet-update runs to completion in the
//     same repo with no further manual steps ----------------------------------
{
  const manifest = {
    profiles: { core: "base", optional: "extra" },
    files: [
      { path: "AGENTS.md", class: "framework", profile: "core" },
      { path: "scripts/plan-sync.mjs", class: "framework", profile: "core" },
      { path: "scripts/optional-tool.mjs", class: "framework", profile: "optional" },
      { path: "GATES.md", class: "generated" },
    ],
  };
  const release = makeReleaseSeq([
    { tag: "v1.0.0", manifest, files: { "AGENTS.md": CORE_AGENTS_V1, "scripts/plan-sync.mjs": CORE_PLAN_SYNC_V1, "scripts/optional-tool.mjs": "// optional\n", "GATES.md": "released GATES\n", ".ratchet-version": "1.0.0\n" } },
    { tag: "v2.0.0", manifest, files: { "AGENTS.md": "AGENTS v2\n", "scripts/plan-sync.mjs": "// plan-sync v2\n", "scripts/optional-tool.mjs": "// optional v2\n", "GATES.md": "released GATES\n", ".ratchet-version": "2.0.0\n" } },
  ]);
  const consumer = makeConsumer({
    seed: { "AGENTS.md": CORE_AGENTS_V1, "scripts/plan-sync.mjs": CORE_PLAN_SYNC_V1, ".ratchet-version": "1.0.0\n" }, // core-only, recorded at 1.0.0
  });
  const r = runUpdate(consumer, release, ["v2.0.0"]); // adopt @1.0.0, then update to 2.0.0 in one run
  assert.equal(r.status, 0, `single invocation must complete: ${r.out}`);
  assert.equal(readFileSync(join(consumer, "AGENTS.md"), "utf8"), "AGENTS v2\n", "framework file refreshed to the target version");
  assert.equal(readFileSync(join(consumer, ".ratchet-version"), "utf8"), "2.0.0\n", "version bumped to the target");
  const install = JSON.parse(readFileSync(join(consumer, ".ratchet-install.json"), "utf8"));
  assert.equal(install.version, "2.0.0", "install record advanced to the target version");
  assert.ok(!existsSync(join(consumer, "scripts/optional-tool.mjs")), "core-only adoption did not pull the optional profile");
}

// --- Criterion 11: adoption that cannot proceed (recorded release unfetchable)
//     names the exact reinstall command, never a stack trace -----------------
{
  const release = stdRelease("v1.0.0", "1.0.0"); // remote only has v1.0.0
  const consumer = makeConsumer({
    seed: { "AGENTS.md": CORE_AGENTS_V1, ".ratchet-version": "9.9.9\n" }, // recorded version absent upstream
  });
  const r = runUpdate(consumer, release, ["v1.0.0"]);
  assert.notEqual(r.status, 0, "unfetchable recorded release must stop the run");
  assert.ok(/bootstrap\.sh --version/.test(r.out), "names the exact reinstall command");
  assert.ok(/9\.9\.9/.test(r.out), "identifies the recorded version it could not fetch");
  noStack(r.out);
}

// --- Criterion 12: exactly one test block per criterion ----------------------
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 1; n <= 12; n++) {
    const hits = src.match(new RegExp(`--- Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "Criterion ${n}" block, found ${hits.length}`);
  }
}

for (const d of dirs) { spawnSync("rm", ["-rf", d]); }
console.log("PASS ratchet-update.test.mjs (12 criteria, end-to-end)");

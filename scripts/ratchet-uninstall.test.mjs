#!/usr/bin/env node
// ratchet-uninstall.test.mjs — end-to-end behaviour tests for the
// manifest-driven uninstaller (issue #241, plan 0108-manifest-aware-uninstall).
// Zero dependencies. Run: node scripts/ratchet-uninstall.test.mjs
//
// Drives the real scripts/ratchet-uninstall.sh against fixture host trees —
// each built with an .ratchet-install.json shaped like scripts/bootstrap.sh
// actually writes one ({version, profiles, installed, generated, hashes}),
// never mocked.
//   1. Uninstall removes every recorded framework path; a previously
//      Ratchet-free repo returns to its pre-install state except for files
//      the host explicitly chose to keep.
//   2. Host-owned files (never recorded as installed) are untouched, even
//      when a shared directory also holds framework files.
//   3. "generated" files (memory/, ...) are kept by default and removed
//      only when named via --purge-memory / --purge-generated.
//   4. A framework file the host modified after install (hash mismatch) is
//      skipped by default, not removed.
//   5. With no .ratchet-install.json, the uninstaller fails with a clear
//      message and changes nothing.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UNINSTALL = fileURLToPath(new URL("./ratchet-uninstall.sh", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "uninstall-host-")); dirs.push(d); return d; };
const write = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function run(host, args) {
  const res = spawnSync("bash", [UNINSTALL, ...args], { cwd: host, encoding: "utf8" });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

// A host with a standard bootstrap install: framework files with correct
// recorded hashes, one generated file, one host-owned file sharing a dir.
function makeInstalledHost() {
  const host = tmp();
  write(host, "AGENTS.md", "MANUAL\n");
  write(host, "scripts/plan-sync.mjs", "// plan-sync\n");
  write(host, ".github/workflows/plan-sync.yml", "name: plan-sync\n");
  write(host, "memory/MEMORY.md", "# memory\n");
  write(host, "scripts/host-own.mjs", "// this is the host's own script\n");
  write(host, "README.md", "# host project\n");
  const hashes = {
    "AGENTS.md": sha256(readFileSync(join(host, "AGENTS.md"))),
    "scripts/plan-sync.mjs": sha256(readFileSync(join(host, "scripts/plan-sync.mjs"))),
    ".github/workflows/plan-sync.yml": sha256(readFileSync(join(host, ".github/workflows/plan-sync.yml"))),
  };
  write(host, ".ratchet-install.json", JSON.stringify({
    version: "9.9.9",
    profiles: ["core"],
    installed: ["AGENTS.md", "scripts/plan-sync.mjs", ".github/workflows/plan-sync.yml"],
    generated: ["memory"],
    hashes,
  }, null, 2));
  return host;
}

// --- Criterion 1: removes every recorded framework path -----------------
{
  const host = makeInstalledHost();
  const r = run(host, ["--yes"]);
  assert.equal(r.status, 0, `uninstall must succeed: ${r.out}`);
  for (const p of ["AGENTS.md", "scripts/plan-sync.mjs", ".github/workflows/plan-sync.yml"]) {
    assert.ok(!existsSync(join(host, p)), `recorded framework path must be gone: ${p}`);
  }
  assert.ok(/removed: AGENTS\.md/.test(r.out), "reports the removal");
  assert.ok(!existsSync(join(host, ".ratchet-install.json")), "a fully clean uninstall drops its own bookkeeping file too");
}

// --- Criterion 2: host-owned files, even in a shared dir, are untouched --
{
  const host = makeInstalledHost();
  const r = run(host, ["--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(host, "scripts/host-own.mjs")), "host's own script in scripts/ survives");
  assert.equal(readFileSync(join(host, "scripts/host-own.mjs"), "utf8"), "// this is the host's own script\n");
  assert.ok(existsSync(join(host, "README.md")), "host README survives");
}

// --- Criterion 3: generated files kept by default, removed only if named -
{
  const host = makeInstalledHost();
  const dry = run(host, []);
  assert.equal(dry.status, 0, dry.out);
  assert.ok(existsSync(join(host, "memory/MEMORY.md")), "dry run never touches generated files");

  const kept = run(host, ["--yes"]);
  assert.equal(kept.status, 0, kept.out);
  assert.ok(existsSync(join(host, "memory/MEMORY.md")), "generated memory/ kept by default");
  assert.ok(/KEPT/.test(kept.out), "reports that generated files were kept");

  const host2 = makeInstalledHost();
  const purged = run(host2, ["--yes", "--purge-memory"]);
  assert.equal(purged.status, 0, purged.out);
  assert.ok(!existsSync(join(host2, "memory")), "--purge-memory removes memory/ when explicitly named");
}

// --- Criterion 4: a locally modified framework file is skipped -----------
{
  const host = makeInstalledHost();
  write(host, "scripts/plan-sync.mjs", "// host edited this after install\n");
  const r = run(host, ["--yes"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(host, "scripts/plan-sync.mjs")), "a locally modified framework file is kept");
  assert.equal(
    readFileSync(join(host, "scripts/plan-sync.mjs"), "utf8"),
    "// host edited this after install\n",
    "the host's edit is preserved verbatim"
  );
  assert.ok(/KEPT \(locally modified/.test(r.out), "explains why the file was kept");
  assert.ok(!existsSync(join(host, "AGENTS.md")), "unmodified recorded files are still removed");
}

// --- Criterion 5: no install manifest present fails clearly, changes nothing
{
  const host = tmp();
  write(host, "AGENTS.md", "MANUAL\n");
  const before = readdirSync(host).sort();
  const r = run(host, ["--yes"]);
  assert.notEqual(r.status, 0, "must fail without .ratchet-install.json");
  assert.ok(/no \.ratchet-install\.json/i.test(r.out), "explains the manifest is missing");
  assert.deepEqual(readdirSync(host).sort(), before, "host tree is unchanged on failure");
}

// --- Meta: exactly one test block per functional criterion ---------------
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 1; n <= 5; n++) {
    const hits = src.match(new RegExp(`--- Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "Criterion ${n}" block, found ${hits.length}`);
  }
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log("PASS ratchet-uninstall.test.mjs (5 criteria, end-to-end)");

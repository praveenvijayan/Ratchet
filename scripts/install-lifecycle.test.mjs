#!/usr/bin/env node
// install-lifecycle.test.mjs — end-to-end tests for issue #242 (plan
// 0109-install-docs-and-e2e-tests): the documented bootstrap-install ->
// update -> uninstall flow, driven through the real scripts/bootstrap.sh,
// scripts/ratchet-update.sh and scripts/ratchet-uninstall.sh against one real
// temporary host git repository and two tagged fixture release repos.
// Zero dependencies. Run: node scripts/install-lifecycle.test.mjs
//   1. README.md documents the bootstrap flow (pinned --version, --profile,
//      the /ratchet-init follow-up) and no longer tells users to copy the repo.
//   2. DOCS.md documents the manifest classes, the available profiles, and
//      the update/uninstall contracts.
//   3. The docs show the curl | bash convenience form alongside a warning
//      against running it unpinned, and a download-then-inspect-then-run
//      alternative.
//   4. A full lifecycle — bootstrap-install, update to a newer fixture
//      version, uninstall — leaves exactly the expected paths at each step,
//      and a full uninstall returns the host to its pre-install tree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const BOOTSTRAP = join(HERE, "bootstrap.sh");
const SELF = fileURLToPath(import.meta.url);

const dirs = [];
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const write = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

// Recursive, sorted, .git-excluded listing of a directory — used to compare
// the host tree before install, after each step, and after a full uninstall.
function listTree(dir) {
  const out = [];
  (function walk(d, prefix) {
    for (const name of readdirSync(d).sort()) {
      if (name === ".git") continue;
      const full = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      statSync(full).isDirectory() ? walk(full, rel) : out.push(rel);
    }
  })(dir, "");
  return out.sort();
}

// A fixture "Ratchet release": a git repo with a manifest + files, tagged.
function makeRelease({ manifest, files, tag }) {
  const dir = tmp("lifecycle-release-");
  writeFileSync(join(dir, "ratchet-manifest.json"), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git(dir, "init", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", `release ${tag}`);
  git(dir, "tag", tag);
  return dir;
}
function makeHost() {
  const dir = tmp("lifecycle-host-");
  git(dir, "init", "-b", "main");
  write(dir, "README.md", "# host project\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}
function run(host, scriptPath, args, remote) {
  const res = spawnSync("bash", [scriptPath, ...args], {
    cwd: host,
    env: { ...process.env, RATCHET_REMOTE: remote || "" },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

// --- Criterion 1: README documents the bootstrap flow -----------------------
{
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const install = readme.slice(readme.indexOf("## Install"), readme.indexOf("## The PAT"));
  assert.ok(/scripts\/bootstrap\.sh/.test(install), "documents scripts/bootstrap.sh");
  assert.ok(/--version/.test(install), "documents pinning a version");
  assert.ok(/--profile/.test(install), "documents profile selection");
  assert.ok(/\/ratchet-init/.test(install), "documents the /ratchet-init follow-up");
  assert.ok(!/Copy this kit into your repo/i.test(install), "no longer tells users to copy the repo");
}

// --- Criterion 2: DOCS documents manifest classes, profiles, and contracts --
{
  const docs = readFileSync(join(REPO_ROOT, "DOCS.md"), "utf8");
  for (const cls of ["framework", "generated", "excluded"]) {
    assert.ok(docs.includes(cls), `documents the "${cls}" manifest class`);
  }
  for (const profile of ["core", "watcher", "release", "herd", "unattended-ci", "claude-plugin"]) {
    assert.ok(docs.includes(profile), `documents the "${profile}" profile`);
  }
  assert.ok(/ratchet-update\.sh/.test(docs), "documents the updater script");
  assert.ok(/ratchet-uninstall\.sh/.test(docs), "documents the uninstaller script");
  assert.ok(/--purge-memory|--purge-generated|--purge-plans/.test(docs), "documents the uninstall purge contract");
}

// --- Criterion 3: docs warn against unpinned curl | bash --------------------
{
  const combined = readFileSync(join(REPO_ROOT, "README.md"), "utf8") + readFileSync(join(REPO_ROOT, "DOCS.md"), "utf8");
  assert.ok(/curl[^\n]*\|\s*bash/.test(combined), "shows the curl | bash invocation");
  assert.ok(/not reproducible|pin a real release tag|pin a release tag/i.test(combined), "warns that an unpinned install is not reproducible");
  assert.ok(/inspect it/i.test(combined), "shows a download-then-inspect-then-run alternative");
}

// --- Criterion 4: full lifecycle leaves exactly the expected paths ----------
{
  const UPDATE_SCRIPT = readFileSync(join(HERE, "ratchet-update.sh"), "utf8");
  const UNINSTALL_SCRIPT = readFileSync(join(HERE, "ratchet-uninstall.sh"), "utf8");
  const manifest = () => ({
    profiles: { core: "base" },
    files: [
      { path: "AGENTS.md", class: "framework", profile: "core" },
      { path: "scripts/ratchet-update.sh", class: "framework", profile: "core" },
      { path: "scripts/ratchet-uninstall.sh", class: "framework", profile: "core" },
      { path: "GATES.md", class: "generated" },
      { path: "memory", class: "generated" },
      { path: ".env.example", class: "generated" },
      { path: "DOCS.md", class: "excluded" },
    ],
  });
  const release = (tag, agentsBody) => makeRelease({
    tag,
    manifest: manifest(),
    files: {
      "AGENTS.md": agentsBody,
      "scripts/ratchet-update.sh": UPDATE_SCRIPT,
      "scripts/ratchet-uninstall.sh": UNINSTALL_SCRIPT,
      "GATES.md": "released GATES (never used — bootstrap scaffolds its own)\n",
      ".env.example": "released env (never used — bootstrap scaffolds its own)\n",
      "DOCS.md": "docs\n",
    },
  });

  const host = makeHost();
  const preInstall = listTree(host);

  // Step 1: bootstrap-install at v1.0.0.
  const installed = run(host, BOOTSTRAP, ["--version", "v1.0.0"], release("v1.0.0", "AGENTS v1\n"));
  assert.equal(installed.status, 0, `bootstrap install must succeed: ${installed.out}`);
  assert.equal(readFileSync(join(host, "AGENTS.md"), "utf8"), "AGENTS v1\n", "installs AGENTS.md at v1");
  assert.ok(!existsSync(join(host, "DOCS.md")), "excluded DOCS.md is never installed");
  const afterInstall = listTree(host);
  assert.deepEqual(
    afterInstall,
    [
      ".env.example", ".ratchet-install.json", ".ratchet-version", "AGENTS.md", "GATES.md", "README.md",
      "memory/ARCHITECTURE.md", "memory/MEMORY.md", "memory/USER.md",
      "scripts/ratchet-uninstall.sh", "scripts/ratchet-update.sh",
    ].sort(),
    "install ships exactly the manifest-selected and scaffolded paths — nothing missing, nothing extra",
  );
  const gatesAfterInstall = readFileSync(join(host, "GATES.md"), "utf8");
  assert.ok(gatesAfterInstall.includes("TODO: format command"), "GATES.md is bootstrap's own scaffold, not the release's file");

  // Step 2: update to v2.0.0 using the host's own installed updater.
  const updated = run(host, join(host, "scripts/ratchet-update.sh"), ["v2.0.0"], release("v2.0.0", "AGENTS v2\n"));
  assert.equal(updated.status, 0, `update must succeed: ${updated.out}`);
  assert.equal(readFileSync(join(host, "AGENTS.md"), "utf8"), "AGENTS v2\n", "AGENTS.md refreshed to v2");
  assert.equal(readFileSync(join(host, ".ratchet-version"), "utf8").trim(), "2.0.0", "version bumped to v2.0.0");
  assert.equal(readFileSync(join(host, "GATES.md"), "utf8"), gatesAfterInstall, "generated GATES.md is untouched by update");
  assert.deepEqual(listTree(host), afterInstall, "update refreshes content only — no path added or removed");

  // Step 3: uninstall, fully purging generated scaffolding to prove a clean round trip.
  const uninstalled = run(
    host,
    join(host, "scripts/ratchet-uninstall.sh"),
    ["--yes", "--purge-memory", "--purge-generated=GATES.md,.env.example,.ratchet-version"],
  );
  assert.equal(uninstalled.status, 0, `uninstall must succeed: ${uninstalled.out}`);
  assert.deepEqual(listTree(host), preInstall, "a full uninstall returns the host to its exact pre-install tree");
}

// --- Meta: exactly one test block per criterion ------------------------------
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 1; n <= 4; n++) {
    const hits = src.match(new RegExp(`--- Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "Criterion ${n}" block, found ${hits.length}`);
  }
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log("PASS install-lifecycle.test.mjs (4 criteria, end-to-end)");

#!/usr/bin/env node
// bootstrap.test.mjs — end-to-end behaviour tests for the bootstrap installer.
// Zero dependencies. Run: node scripts/bootstrap.test.mjs
//
// One test per acceptance criterion of issue #238 (plan 0105-bootstrap-installer),
// driven through the real scripts/bootstrap.sh against a LOCAL fixture remote (a
// git repo with a tagged tree) — the true download→select→install path, not a
// mock. Each run installs into a throwaway host git repo.
//   1. A pinned install writes exactly the framework files of the chosen
//      profile(s), plus .ratchet-version and .ratchet-install.json, and prints
//      /ratchet-init in the next steps.
//   2. `excluded` files (plans, *.test.mjs, DOCS/branding) never land in the host.
//   3. --dry-run reports and leaves the host byte-for-byte unchanged.
//   4. An existing host file is never overwritten without --force; the run lists
//      each conflict, exits non-zero, and changes nothing.
//   5. Running outside a git repo fails clearly before downloading anything.
//   6. A missing --version fails; --version main installs but warns it is unpinned.
//   7. An unresolvable ref fails clearly, names the ref, and leaves the host alone.
//   8. A manifest path that escapes the target is rejected.
//   9. The installer copies only manifest files — never .env or local secrets.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP = fileURLToPath(new URL("./bootstrap.sh", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const write = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

// A fixture "Ratchet release": a git repo with a manifest + files, tagged.
function makeRelease({ manifest, files, tag = "v9.9.9" }) {
  const dir = tmp("btstrap-release-");
  writeFileSync(join(dir, "ratchet-manifest.json"), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git(dir, "init", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "release");
  git(dir, "tag", tag);
  return dir;
}
function makeHost() {
  const dir = tmp("btstrap-host-");
  git(dir, "init", "-b", "main");
  write(dir, "README.md", "# host project\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}
function run(host, args, remote) {
  const res = spawnSync("bash", [BOOTSTRAP, ...args], {
    cwd: host,
    env: { ...process.env, RATCHET_REMOTE: remote || "" },
    encoding: "utf8",
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}
const noStack = (out) => assert.ok(!/\bat\s+\S+:\d+/.test(out), "no stack trace in output");

// Standard release used by most tests: core + watcher framework, plus excluded and generated.
const STD = {
  manifest: {
    profiles: { core: "base", watcher: "watch" },
    files: [
      { path: "AGENTS.md", class: "framework", profile: "core" },
      { path: "scripts/plan-sync.mjs", class: "framework", profile: "core" },
      { path: "scripts/ratchet-watch.sh", class: "framework", profile: "watcher" },
      { path: "plan/README.md", class: "framework", profile: "core" },
      { path: "GATES.md", class: "generated" },
      { path: "memory", class: "generated" },
      { path: ".env.example", class: "generated" },
      { path: ".ratchet-version", class: "generated" },
      { path: ".claude/skills", class: "generated" },
      { path: "plugin/skills", class: "generated" },
      { path: "DOCS.md", class: "excluded" },
      { path: "scripts/foo.test.mjs", class: "excluded" },
      { path: "plan", class: "excluded" },
    ],
  },
  files: {
    "AGENTS.md": "MANUAL\n",
    "scripts/plan-sync.mjs": "// plan-sync\n",
    "scripts/ratchet-watch.sh": "# watch\n",
    "plan/README.md": "# plan/README.md\n",
    "DOCS.md": "docs\n",
    "scripts/foo.test.mjs": "// test\n",
    "plan/idea.md": "idea\n",
    ".env": "SECRET=1\n",
  },
};

// --- Criterion 1: pinned install writes framework files + version + manifest -
{
  const release = makeRelease(STD);
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9", "--profile", "core"], release);
  assert.equal(r.status, 0, `pinned install must succeed: ${r.out}`);
  assert.ok(existsSync(join(host, "AGENTS.md")), "installs a core framework file");
  assert.ok(existsSync(join(host, "scripts/plan-sync.mjs")), "installs a core framework script");
  assert.equal(readFileSync(join(host, ".ratchet-version"), "utf8").trim(), "9.9.9", "normalizes the pinned version");
  const inst = JSON.parse(readFileSync(join(host, ".ratchet-install.json"), "utf8"));
  assert.deepEqual(inst.installed.sort(), ["AGENTS.md", "plan/README.md", "scripts/plan-sync.mjs"], "records exactly what it installed");
  assert.ok(inst.profiles.includes("core"), "records the profile");
  assert.ok(r.out.includes("/ratchet-init"), "prints /ratchet-init in the next steps");
  assert.ok(!existsSync(join(host, "scripts/ratchet-watch.sh")), "an unselected profile's files are not installed");
}

// --- Criterion 2: excluded files never land in the host ---------------------
{
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9"], makeRelease(STD));
  assert.equal(r.status, 0, r.out);
  for (const p of ["DOCS.md", "scripts/foo.test.mjs", "plan/idea.md"]) {
    assert.ok(!existsSync(join(host, p)), `excluded path must be absent: ${p}`);
  }
}

// --- Criterion 3: --dry-run changes nothing ---------------------------------
{
  const host = makeHost();
  const before = readdirSync(host).sort();
  const r = run(host, ["--version", "v9.9.9", "--dry-run"], makeRelease(STD));
  assert.equal(r.status, 0, r.out);
  assert.ok(/would create/i.test(r.out), "reports what it would create");
  assert.ok(!existsSync(join(host, "AGENTS.md")), "dry run writes no framework file");
  assert.ok(!existsSync(join(host, ".ratchet-version")), "dry run writes no version file");
  assert.deepEqual(readdirSync(host).sort(), before, "host tree is byte-for-byte unchanged");
}

// --- Criterion 4: never overwrite without --force; conflict aborts cleanly ---
{
  const host = makeHost();
  write(host, "AGENTS.md", "HOST OWNS THIS\n");
  const blocked = run(host, ["--version", "v9.9.9"], makeRelease(STD));
  assert.notEqual(blocked.status, 0, "an existing file must block the install");
  assert.ok(/conflict:\s*AGENTS\.md/.test(blocked.out), "lists the conflicting path");
  assert.equal(readFileSync(join(host, "AGENTS.md"), "utf8"), "HOST OWNS THIS\n", "the host file is untouched");
  assert.ok(!existsSync(join(host, "scripts/plan-sync.mjs")), "nothing else was installed");
  assert.ok(!existsSync(join(host, ".ratchet-version")), "no version written on abort");

  const forced = run(host, ["--version", "v9.9.9", "--force"], makeRelease(STD));
  assert.equal(forced.status, 0, `--force must overwrite: ${forced.out}`);
  assert.equal(readFileSync(join(host, "AGENTS.md"), "utf8"), "MANUAL\n", "--force replaces the file");
}

// --- Criterion 5: outside a git repo, fail before downloading ----------------
{
  const notRepo = tmp("btstrap-nogit-");
  const r = run(notRepo, ["--version", "v9.9.9"], makeRelease(STD));
  assert.notEqual(r.status, 0, "a non-git directory must fail");
  assert.ok(/not a git repository/i.test(r.out), "says it is not a git repository");
  assert.ok(!existsSync(join(notRepo, "AGENTS.md")), "installs nothing");
  noStack(r.out);
}

// --- Criterion 6: --version is required; --version main installs but warns ----
{
  const host = makeHost();
  const missing = run(host, ["--profile", "core"], makeRelease(STD));
  assert.notEqual(missing.status, 0, "a missing --version must fail");
  assert.ok(/--version/.test(missing.out), "explains that --version is required");

  const host2 = makeHost();
  const main = run(host2, ["--version", "main"], makeRelease(STD));
  assert.equal(main.status, 0, `--version main must install: ${main.out}`);
  assert.ok(/WARNING/.test(main.out) && /not reproducible/i.test(main.out), "warns that main is unpinned");
}

// --- Criterion 7: an unresolvable ref fails clearly, host unchanged ----------
{
  const host = makeHost();
  const before = readdirSync(host).sort();
  const r = run(host, ["--version", "v0.0.404"], makeRelease(STD));
  assert.notEqual(r.status, 0, "an unknown ref must fail");
  assert.ok(r.out.includes("v0.0.404"), "names the ref it could not resolve");
  assert.deepEqual(readdirSync(host).sort(), before, "host left unchanged on download failure");
  noStack(r.out);
}

// --- Criterion 8: a path that escapes the target is rejected -----------------
{
  const evil = makeRelease({
    manifest: { profiles: { core: "base" }, files: [{ path: "../evil.txt", class: "framework", profile: "core" }] },
    files: { "AGENTS.md": "x\n" },
  });
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9"], evil);
  assert.notEqual(r.status, 0, "an escaping path must be rejected");
  assert.ok(/escapes the target/i.test(r.out), "explains the traversal rejection");
  assert.ok(!existsSync(join(host, "..", "evil.txt")), "nothing is written outside the target");
}

// --- Criterion 9: only manifest files are copied — never .env / secrets ------
{
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9", "--profile", "watcher"], makeRelease(STD));
  assert.equal(r.status, 0, r.out);
  assert.ok(!existsSync(join(host, ".env")), "never copies .env (it is not in the manifest)");
  const inst = JSON.parse(readFileSync(join(host, ".ratchet-install.json"), "utf8"));
  assert.ok(inst.installed.every((p) => !/\.env$/.test(p)), "the install record contains no secret files");
  assert.ok(inst.installed.includes("scripts/ratchet-watch.sh"), "selecting a profile adds its files atop core");
}

// --- Criterion 10: scaffolded files have template content, none of Ratchet's own ---
{
  const release = makeRelease(STD);
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9"], release);
  assert.equal(r.status, 0, r.out);

  // GATES.md has TODO placeholders, not Ratchet's actual gate commands
  const gates = readFileSync(join(host, "GATES.md"), "utf8");
  assert.ok(gates.includes("TODO: format command"), "GATES.md has TODO format placeholder");
  assert.ok(gates.includes("TODO: test command"), "GATES.md has TODO test placeholder");
  assert.ok(!gates.includes("node scripts/plan-sync.test.mjs"), "GATES.md has no Ratchet-specific test gate");
  assert.ok(!gates.includes("node scripts/bootstrap.test.mjs"), "GATES.md has no Ratchet-specific test gate");

  // memory/ files exist with clean scaffolds
  assert.ok(existsSync(join(host, "memory/USER.md")), "memory/USER.md scaffolded");
  assert.ok(existsSync(join(host, "memory/MEMORY.md")), "memory/MEMORY.md scaffolded");
  assert.ok(existsSync(join(host, "memory/ARCHITECTURE.md")), "memory/ARCHITECTURE.md scaffolded");
  const mem = readFileSync(join(host, "memory/MEMORY.md"), "utf8");
  assert.ok(!mem.includes("Architecture & decisions"), "MEMORY.md has no Ratchet project memory content");

  // .env.example scaffolded
  assert.ok(existsSync(join(host, ".env.example")), ".env.example scaffolded");
  const env = readFileSync(join(host, ".env.example"), "utf8");
  assert.ok(env.includes("GITHUB_PAT="), ".env.example has PAT template");
}

// --- Criterion 11: plan/ contains only plan/README.md, no Ratchet plan files ---
{
  const release = makeRelease(STD);
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9"], release);
  assert.equal(r.status, 0, r.out);

  assert.ok(existsSync(join(host, "plan/README.md")), "plan/README.md exists (framework)");
  assert.ok(!existsSync(join(host, "plan/idea.md")), "Ratchet plan file is absent");
  assert.ok(!existsSync(join(host, "plan/done")), "plan/done/ is absent");
  assert.ok(!existsSync(join(host, "plan/examples")), "plan/examples/ is absent");
}

// --- Criterion 12: existing generated file is left unchanged and reported as skipped ---
{
  const release = makeRelease(STD);
  const host = makeHost();
  const hostGates = "<!-- HOST OWNED GATES -->\n\n# My Gates\n\n| Order | Gate | Command | Pass condition |\n|-------|------|---------|----------------|\n| 1 | format | cargo fmt --check | -- |\n";
  write(host, "GATES.md", hostGates);
  const r = run(host, ["--version", "v9.9.9"], release);
  assert.equal(r.status, 0, r.out);
  assert.ok(/skipped.*already exists.*GATES\.md/i.test(r.out), "reports GATES.md as skipped (already exists)");
  assert.equal(readFileSync(join(host, "GATES.md"), "utf8"), hostGates, "existing GATES.md is byte-for-byte unchanged");

  const inst = JSON.parse(readFileSync(join(host, ".ratchet-install.json"), "utf8"));
  assert.ok(!inst.generated.includes("GATES.md"), "GATES.md is not in generated list when skipped");
}

// --- Criterion 13: install manifest records scaffolded files as generated ---
{
  const release = makeRelease(STD);
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9"], release);
  assert.equal(r.status, 0, r.out);

  const inst = JSON.parse(readFileSync(join(host, ".ratchet-install.json"), "utf8"));
  assert.ok(Array.isArray(inst.generated), "manifest has a generated array");
  assert.ok(inst.generated.includes("GATES.md"), "GATES.md is in generated");
  assert.ok(inst.generated.includes("memory"), "memory is in generated");
  assert.ok(inst.generated.includes(".env.example"), ".env.example is in generated");
  assert.ok(Array.isArray(inst.installed), "manifest has an installed array");
  assert.ok(!inst.installed.includes("GATES.md"), "GATES.md is not in installed (framework)");
  assert.ok(!inst.installed.includes("memory"), "memory is not in installed (framework)");
  assert.ok(!inst.installed.includes(".env.example"), ".env.example is not in installed (framework)");
}

// === Issue #325 — a missing --version ref fails clearly (plan 0138) ==========
// One test per acceptance criterion of #325, each named after the criterion.
// A bad ref is exercised against a real, valid fixture release so the failure
// is genuinely "ref not found on the remote", not a broken remote.

// --- #325 AC1: a nonexistent ref exits non-zero BEFORE writing any file ------
{
  const host = makeHost();
  const before = readdirSync(host).sort();
  const r = run(host, ["--version", "v3.2.1-nope"], makeRelease(STD));
  assert.notEqual(r.status, 0, "a nonexistent ref must exit non-zero");
  assert.deepEqual(readdirSync(host).sort(), before, "no file is written to the host on a missing ref");
  assert.ok(!existsSync(join(host, ".ratchet-version")), "no version file written");
  assert.ok(!existsSync(join(host, "AGENTS.md")), "no framework file written");
}

// --- #325 AC2: the message names the ref and points to releases / --version main, never a raw 404 ---
{
  const host = makeHost();
  const r = run(host, ["--version", "v3.2.1-nope"], makeRelease(STD));
  assert.notEqual(r.status, 0, "a nonexistent ref must fail");
  assert.ok(r.out.includes("v3.2.1-nope"), "names the requested ref");
  assert.ok(/releases/i.test(r.out), "points at the releases page to find valid versions");
  assert.ok(/--version main/.test(r.out), "offers --version main to track latest");
  assert.ok(!/\b404\b/.test(r.out), "never surfaces a raw curl/git 404 error");
  noStack(r.out);
}

// --- #325 AC3: a ref that exists still installs exactly as before (regression) ---
{
  const host = makeHost();
  const r = run(host, ["--version", "v9.9.9", "--profile", "core"], makeRelease(STD));
  assert.equal(r.status, 0, `an existing ref must install: ${r.out}`);
  assert.ok(existsSync(join(host, "AGENTS.md")), "installs the framework file");
  assert.equal(readFileSync(join(host, ".ratchet-version"), "utf8").trim(), "9.9.9", "records the pinned version as before");
}

// --- Meta: exactly one test block per functional criterion ------------------
{
  const src = readFileSync(SELF, "utf8");
  for (let n = 1; n <= 13; n++) {
    const hits = src.match(new RegExp(`--- Criterion ${n}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "Criterion ${n}" block, found ${hits.length}`);
  }
  for (const ac of ["AC1", "AC2", "AC3"]) {
    const hits = src.match(new RegExp(`--- #325 ${ac}:`, "g")) || [];
    assert.equal(hits.length, 1, `expected exactly one "#325 ${ac}" block, found ${hits.length}`);
  }
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log("PASS bootstrap.test.mjs (13 + #325×3 criteria, end-to-end)");

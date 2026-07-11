#!/usr/bin/env node
// herd-mascots-install.test.mjs — the acceptance criteria of issue #291 are
// the test plan: exactly one test per criterion of the mascots/ install
// manifest delivery, driven through the real scripts/bootstrap.sh,
// scripts/ratchet-update.sh, and scripts/ratchet-uninstall.sh against fixture
// release repos. Offline, zero deps. Run:
//   node scripts/herd-mascots-install.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const BOOTSTRAP = join(HERE, "bootstrap.sh");
const UPDATE_SCRIPT_SRC = readFileSync(join(HERE, "ratchet-update.sh"), "utf8");
const UNINSTALL_SCRIPT_SRC = readFileSync(join(HERE, "ratchet-uninstall.sh"), "utf8");
const SELF = fileURLToPath(import.meta.url);

const MASCOT_NAMES = ["fig-goggles", "fig-hero", "fig-labcoat", "fig-tropical", "fig-varsity", "fig-suit"];

const dirs = [];
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const write = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };

function makeRelease({ manifest, files, tag }) {
  const dir = tmp("mascots-release-");
  writeFileSync(join(dir, "ratchet-manifest.json"), JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git(dir, "init", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", `release ${tag}`);
  git(dir, "tag", tag);
  return dir;
}
function makeHost() {
  const dir = tmp("mascots-host-");
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

// Fake mascot PNGs — small binary blobs, one per figure. The test verifies
// delivery and non-overwrite, not art fidelity.
const mascotFiles = Object.fromEntries(
  MASCOT_NAMES.map((name) => [`mascots/${name}.png`, Buffer.from(`fake-${name}`)]),
);

function mascotsManifest() {
  return {
    profiles: { core: "base" },
    files: [
      { path: "AGENTS.md", class: "framework", profile: "core" },
      { path: "scripts/ratchet-update.sh", class: "framework", profile: "core" },
      { path: "scripts/ratchet-uninstall.sh", class: "framework", profile: "core" },
      { path: "GATES.md", class: "generated" },
      { path: "mascots", class: "generated" },
      { path: "DOCS.md", class: "excluded" },
    ],
  };
}
function mascotsRelease(tag, agentsBody) {
  return makeRelease({
    tag,
    manifest: mascotsManifest(),
    files: {
      "AGENTS.md": agentsBody,
      "scripts/ratchet-update.sh": UPDATE_SCRIPT_SRC,
      "scripts/ratchet-uninstall.sh": UNINSTALL_SCRIPT_SRC,
      "GATES.md": "scaffolded by bootstrap, not from release\n",
      "DOCS.md": "docs\n",
      ...mascotFiles,
    },
  });
}

// --- #291 criterion 1: a first-time install into a fresh host project delivers
// mascots/ with all six figure PNGs (fig-goggles, fig-hero, fig-labcoat,
// fig-tropical, fig-varsity, fig-suit). ---
{
  const host = makeHost();
  const release = mascotsRelease("v1.0.0", "AGENTS v1\n");
  const installed = run(host, BOOTSTRAP, ["--version", "v1.0.0"], release);
  assert.equal(installed.status, 0, `bootstrap install must succeed: ${installed.out}`);
  assert.ok(existsSync(join(host, "mascots")), "mascots/ directory is created on first install");
  const files = readdirSync(join(host, "mascots")).sort();
  assert.deepEqual(
    files,
    MASCOT_NAMES.map((n) => `${n}.png`).sort(),
    "all six mascot PNGs are delivered",
  );
  for (const name of MASCOT_NAMES) {
    const body = readFileSync(join(host, `mascots/${name}.png`));
    assert.equal(body.toString(), `fake-${name}`, `mascot ${name}.png content matches the release`);
  }
}

// --- #291 criterion 2: mascots/ is declared in ratchet-manifest.json and the
// scripts/manifest-check.mjs gate passes. ---
{
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "ratchet-manifest.json"), "utf8"));
  const mascotsEntry = (manifest.files || []).find((e) => e.path === "mascots");
  assert.ok(mascotsEntry, "mascots/ is declared in ratchet-manifest.json");
  assert.equal(mascotsEntry.class, "generated", "mascots/ is classified as generated (scaffolded once, never overwritten)");
  assert.ok(existsSync(join(REPO_ROOT, "mascots")), "mascots/ exists on disk");
  assert.deepEqual(
    readdirSync(join(REPO_ROOT, "mascots")).sort(),
    MASCOT_NAMES.map((n) => `${n}.png`).sort(),
    "all six figure PNGs are present on disk",
  );
  const check = spawnSync(process.execPath, ["scripts/manifest-check.mjs"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, `manifest-check.mjs must pass: ${(check.stderr || check.stdout).trim()}`);
}

// --- #291 criterion 3: /ratchet-update on a host project never overwrites an
// existing mascot file — a host that replaced or recolored its art keeps it
// across updates. ---
{
  const host = makeHost();
  const v1 = mascotsRelease("v1.0.0", "AGENTS v1\n");
  const installed = run(host, BOOTSTRAP, ["--version", "v1.0.0"], v1);
  assert.equal(installed.status, 0, `install must succeed: ${installed.out}`);

  // Host recolors one mascot file after install.
  writeFileSync(join(host, "mascots/fig-hero.png"), Buffer.from("HOST-RECOLORED"));

  // Update to v2.0.0 which carries the same mascot content upstream.
  const v2 = mascotsRelease("v2.0.0", "AGENTS v2\n");
  const updated = run(host, join(host, "scripts/ratchet-update.sh"), ["v2.0.0"], v2);
  assert.equal(updated.status, 0, `update must succeed: ${updated.out}`);

  // The host's recolored file is untouched — generated paths are never
  // overwritten by an update.
  assert.equal(
    readFileSync(join(host, "mascots/fig-hero.png"), "utf8"),
    "HOST-RECOLORED",
    "host's recolored mascot file survives an update",
  );
  // Other mascot files are also untouched (still the v1 content).
  for (const name of MASCOT_NAMES) {
    if (name === "fig-hero") continue;
    assert.equal(
      readFileSync(join(host, `mascots/${name}.png`)).toString(),
      `fake-${name}`,
      `mascot ${name}.png is untouched by the update`,
    );
  }
}

// --- #291 criterion 4: /ratchet-update on a host project installed before this
// change adds the missing mascots/ folder — an older install is not stranded
// without art. ---
{
  const host = makeHost();
  // Simulate a pre-#291 install: a manifest that does NOT include mascots/.
  const oldManifest = {
    profiles: { core: "base" },
    files: [
      { path: "AGENTS.md", class: "framework", profile: "core" },
      { path: "scripts/ratchet-update.sh", class: "framework", profile: "core" },
      { path: "scripts/ratchet-uninstall.sh", class: "framework", profile: "core" },
      { path: "GATES.md", class: "generated" },
      { path: "DOCS.md", class: "excluded" },
    ],
  };
  const oldRelease = makeRelease({
    tag: "v0.9.0",
    manifest: oldManifest,
    files: {
      "AGENTS.md": "AGENTS v0\n",
      "scripts/ratchet-update.sh": UPDATE_SCRIPT_SRC,
      "scripts/ratchet-uninstall.sh": UNINSTALL_SCRIPT_SRC,
      "GATES.md": "scaffolded\n",
      "DOCS.md": "docs\n",
    },
  });
  const installed = run(host, BOOTSTRAP, ["--version", "v0.9.0"], oldRelease);
  assert.equal(installed.status, 0, `old install must succeed: ${installed.out}`);
  assert.ok(!existsSync(join(host, "mascots")), "pre-#291 install has no mascots/ folder");
  assert.ok(
    !JSON.parse(readFileSync(join(host, ".ratchet-install.json"), "utf8")).generated.includes("mascots"),
    "pre-#291 install record does not list mascots/",
  );

  // Update to v1.0.0 which includes mascots/ in the manifest.
  const newRelease = mascotsRelease("v1.0.0", "AGENTS v1\n");
  const updated = run(host, join(host, "scripts/ratchet-update.sh"), ["v1.0.0"], newRelease);
  assert.equal(updated.status, 0, `update must succeed: ${updated.out}`);

  // The mascots/ folder is now present with all six PNGs.
  assert.ok(existsSync(join(host, "mascots")), "mascots/ folder is added by the update");
  assert.deepEqual(
    readdirSync(join(host, "mascots")).sort(),
    MASCOT_NAMES.map((n) => `${n}.png`).sort(),
    "all six mascot PNGs are delivered by the update",
  );
  for (const name of MASCOT_NAMES) {
    assert.equal(
      readFileSync(join(host, `mascots/${name}.png`)).toString(),
      `fake-${name}`,
      `mascot ${name}.png content matches the release after update`,
    );
  }

  // The install record now lists mascots/ in its generated array.
  const installRecord = JSON.parse(readFileSync(join(host, ".ratchet-install.json"), "utf8"));
  assert.ok(installRecord.generated.includes("mascots"), "install record now lists mascots/ as generated");
}

// --- #291 criterion 5: ratchet-uninstall keeps mascots/ by default and removes
// it only when explicitly purged, matching the existing generated-file
// behaviour. ---
{
  const host = makeHost();
  const release = mascotsRelease("v1.0.0", "AGENTS v1\n");
  const installed = run(host, BOOTSTRAP, ["--version", "v1.0.0"], release);
  assert.equal(installed.status, 0, `install must succeed: ${installed.out}`);

  // Default uninstall (no --purge-generated=mascots) keeps mascots/.
  const kept = run(host, join(host, "scripts/ratchet-uninstall.sh"), ["--yes"]);
  assert.equal(kept.status, 0, `uninstall must succeed: ${kept.out}`);
  assert.ok(existsSync(join(host, "mascots")), "mascots/ is kept by default on uninstall");
  assert.ok(/KEPT/.test(kept.out), "uninstall reports mascots/ as kept");

  // Explicit purge removes mascots/.
  const host2 = makeHost();
  const installed2 = run(host2, BOOTSTRAP, ["--version", "v1.0.0"], release);
  assert.equal(installed2.status, 0, `second install must succeed: ${installed2.out}`);
  const purged = run(host2, join(host2, "scripts/ratchet-uninstall.sh"), ["--yes", "--purge-generated=mascots"]);
  assert.equal(purged.status, 0, `purge uninstall must succeed: ${purged.out}`);
  assert.ok(!existsSync(join(host2, "mascots")), "mascots/ is removed when explicitly purged");
}

// --- #291 criterion 6: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-mascots-install.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 6; i++) {
    const hits = (self.match(new RegExp(`#291 criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `#291 criterion ${i} must have exactly one test named after it`);
  }
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log("PASS herd-mascots-install.test.mjs (5 criteria)");

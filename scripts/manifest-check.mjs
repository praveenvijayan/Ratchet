#!/usr/bin/env node
// manifest-check.mjs — validate ratchet-manifest.json against the real repo.
// Zero dependencies. Run: node scripts/manifest-check.mjs
//
// The manifest is the single source of truth for which files Ratchet ships.
// This gate keeps it honest both ways: (drift-in) every file a workflow
// references or a shipped non-test script imports must be classified in the
// manifest; (drift-out) every path the manifest lists must exist on disk. Each
// failure prints the offending path(s) as a clear message and exits non-zero —
// never a stack trace. Set MANIFEST_ROOT to check a tree other than this repo.

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_CLASSES = new Set(["framework", "generated", "excluded"]);

export function repoRoot() {
  return process.env.MANIFEST_ROOT || fileURLToPath(new URL("../", import.meta.url));
}

function tagged(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

// Load + shallow-validate the manifest. Throws a user-facing Error (no stack
// shown) when missing, unparseable, or structurally invalid.
export function loadManifest(root) {
  const path = join(root, "ratchet-manifest.json");
  if (!existsSync(path)) throw tagged(`Manifest not found: ${path}\nExpected ratchet-manifest.json at the repo root.`);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw tagged(`Manifest is not valid JSON: ${path}\n  ${e.message}`);
  }
  if (!data || !Array.isArray(data.files)) throw tagged(`Manifest is malformed: ${path}\n  expected a top-level "files" array.`);
  return data;
}

function globToRegExp(pattern) {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
}

// Directory entries cover their whole subtree; glob entries match `*` within a segment.
export function entryCovers(entry, ref) {
  if (entry.glob) return globToRegExp(entry.path).test(ref);
  return entry.path === ref || ref.startsWith(entry.path + "/");
}

// Every real file referenced by a shipped workflow or imported by a shipped
// (non-test) script — the paths that MUST be classified.
export function collectReferents(root) {
  const refs = new Set();
  const add = (p) => refs.add(p.replace(/\\/g, "/"));
  const wfDir = join(root, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
      const text = readFileSync(join(wfDir, f), "utf8");
      for (const m of text.matchAll(/(?:scripts|\.github\/workflows)\/[A-Za-z0-9._/-]+\.(?:mjs|js|sh|ya?ml)/g)) add(m[0]);
      for (const m of text.matchAll(/(?:AGENTS|CLAUDE|GEMINI|DOCS|GATES|README)\.md/g)) add(m[0]);
      for (const m of text.matchAll(/\bsetup\.sh\b/g)) add(m[0]);
    }
  }
  const scriptsDir = join(root, "scripts");
  if (existsSync(scriptsDir)) {
    for (const f of readdirSync(scriptsDir).filter((n) => /\.mjs$/.test(n) && !n.endsWith(".test.mjs"))) {
      const text = readFileSync(join(scriptsDir, f), "utf8");
      for (const m of text.matchAll(/from\s+['"]\.\/([A-Za-z0-9._-]+\.(?:mjs|js))['"]/g)) add(`scripts/${m[1]}`);
    }
  }
  // Only real files count — a token resolving to no file is not a reference.
  return [...refs].filter((r) => existsSync(join(root, r)) && statSync(join(root, r)).isFile()).sort();
}

// Every scripts/*.test.mjs file on disk — tests must never ship to host installs.
export function collectTestFiles(root) {
  const scriptsDir = join(root, "scripts");
  if (!existsSync(scriptsDir)) return [];
  return readdirSync(scriptsDir)
    .filter((n) => n.endsWith(".test.mjs") && statSync(join(scriptsDir, n)).isFile())
    .map((n) => `scripts/${n}`)
    .sort();
}

function globMatches(root, pattern) {
  const dir = dirname(pattern);
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const re = globToRegExp(pattern);
  return readdirSync(abs).map((n) => `${dir}/${n}`).filter((p) => re.test(p));
}

// Full report: structural issues + both drift directions.
export function checkReport(root = repoRoot()) {
  let manifest;
  try {
    manifest = loadManifest(root);
  } catch (e) {
    if (e.userFacing) return { ok: false, fatal: e.message, structural: [], missingFromManifest: [], missingOnDisk: [], excludedReferents: [], shippableTests: [] };
    throw e;
  }
  const entries = manifest.files;
  const profiles = manifest.profiles || {};
  const structural = [];
  for (const e of entries) {
    if (!VALID_CLASSES.has(e.class)) structural.push(`${e.path}: unknown class "${e.class}" (framework | generated | excluded)`);
    if (e.class === "framework") {
      if (!e.profile) structural.push(`${e.path}: framework entry must name exactly one profile`);
      else if (!profiles[e.profile]) structural.push(`${e.path}: profile "${e.profile}" is not declared in "profiles"`);
    }
  }
  const missingFromManifest = collectReferents(root).filter((ref) => !entries.some((e) => entryCovers(e, ref)));
  // A script a shipped workflow invokes or a shipped script imports, but the
  // manifest classifies as `excluded` — would silently break a shipped workflow.
  // Scoped to scripts (.mjs/.js/.sh): markdown and workflow YAMLs are config,
  // not scripts, and may be intentionally excluded (e.g. DOCS.md, README.md).
  const isScript = (p) => /\.(?:mjs|js|sh)$/.test(p);
  const excludedReferents = collectReferents(root).filter((ref) => {
    if (!isScript(ref)) return false;
    const entry = entries.find((e) => entryCovers(e, ref));
    return entry && entry.class === "excluded";
  });
  // A test file classified as `framework` or `generated` — would leak Ratchet's
  // test suite into host installs.
  const shippableTests = collectTestFiles(root).filter((f) => {
    const entry = entries.find((e) => entryCovers(e, f));
    return entry && (entry.class === "framework" || entry.class === "generated");
  });
  const missingOnDisk = [];
  for (const e of entries) {
    if (e.glob) {
      if (globMatches(root, e.path).length === 0) missingOnDisk.push(`${e.path} (glob matches no files)`);
    } else if (!existsSync(join(root, e.path))) missingOnDisk.push(e.path);
  }
  const ok = !structural.length && !missingFromManifest.length && !missingOnDisk.length && !excludedReferents.length && !shippableTests.length;
  return { ok, fatal: null, structural, missingFromManifest, missingOnDisk, excludedReferents, shippableTests };
}

// Render the report as human-readable lines + an exit code.
export function reportLines(report) {
  if (report.fatal) return { code: 2, lines: [report.fatal] };
  if (report.ok) return { code: 0, lines: ["manifest-check: ratchet-manifest.json is consistent with the repo."] };
  const lines = ["manifest-check: ratchet-manifest.json has drifted from the repository.\n"];
  if (report.structural.length) {
    lines.push("Structural problems:", ...report.structural.map((s) => `  ✗ ${s}`), "");
  }
  if (report.missingFromManifest.length) {
    lines.push("Referenced by a workflow or shipped script but MISSING from the manifest:",
      ...report.missingFromManifest.map((p) => `  ✗ ${p}`),
      "  → add each to ratchet-manifest.json with its class and profile.", "");
  }
  if (report.missingOnDisk.length) {
    lines.push("Listed in the manifest but MISSING on disk:",
      ...report.missingOnDisk.map((p) => `  ✗ ${p}`),
      "  → remove the stale entry or restore the file.", "");
  }
  if (report.excludedReferents.length) {
    lines.push("Referenced by a shipped workflow or imported by a shipped script but classified `excluded`:",
      ...report.excludedReferents.map((p) => `  ✗ ${p}`),
      "  → reclassify as `framework` with its owning profile — excluding a runtime script breaks shipped workflows.", "");
  }
  if (report.shippableTests.length) {
    lines.push("Test files classified as shippable (`framework`/`generated`):",
      ...report.shippableTests.map((p) => `  ✗ ${p}`),
      "  → reclassify as `excluded` — tests must never leak into host installs.", "");
  }
  return { code: 1, lines };
}

// CLI — run only when invoked directly (robust to spaces in the path).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const { code, lines } = reportLines(checkReport());
  (code === 0 ? console.log : console.error)(lines.join("\n"));
  process.exit(code);
}

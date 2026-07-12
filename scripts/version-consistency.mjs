#!/usr/bin/env node
// version-consistency.mjs — the SINGLE source of truth for where the framework's
// version lives, what "the version" means, and the gate that fails a tree whose
// version strings disagree. The number is duplicated across five files:
//   - `.ratchet-version`                    — the sole line
//   - `plugin/.claude-plugin/plugin.json`   — the `"version"` field
//   - `README.md`                           — the `framework-vX.Y.Z` shields badge
//   - `DOCS.md`                             — the `Version X.Y.Z` header line
//   - `index.html`                          — every `vX.Y.Z` in the static site
//     (hero eyebrow + install/bootstrap commands), each occurrence checked
// Nothing else checks they still match, so they can drift apart silently and
// ship mixed. This module catches a disagreeing tree before a PR opens.
//
// The definitions here (VERSION_LOCATIONS, normalizeVersion, readVersions) are
// exported so the release write-back (`0049-release-version-writeback`) and the
// updater (`0050-updater-records-tag-version`) reuse the same list of files and
// the same canonical rule — compare on the bare MAJOR.MINOR.PATCH, ignoring a
// leading `v` — instead of re-deriving where versions live or how they compare.
//
// Exits 0 when all four locations carry the same semver (so `3.3.6` and `v3.3.6`
// are equal); exits non-zero — with a clear per-file report, never a stack
// trace — when any location disagrees or cannot be read.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/version-consistency.mjs
// Override the root for testing with VERSION_ROOT=/dir.

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A version location could not be read or parsed. Callers catch this to report
// a clear, user-facing message instead of leaking a stack trace.
export class VersionLocationError extends Error {}

// The canonical comparison rule: reduce any accepted spelling of a version to
// its bare `MAJOR.MINOR.PATCH`, so a bare `3.3.6` and a `v`-prefixed `v3.3.6`
// compare equal. Throws VersionLocationError on anything that is not semver.
export function normalizeVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(raw).trim());
  if (!m) {
    throw new VersionLocationError(
      `'${raw}' is not a MAJOR.MINOR.PATCH version (optionally v-prefixed)`,
    );
  }
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// Each location knows its file and how to pull the raw version string out of
// that file's text. `extract` returns the raw string (which may carry a leading
// `v`) or throws VersionLocationError when the expected marker is absent —
// never a bare `undefined` that would surface later as a confusing crash.
export const VERSION_LOCATIONS = [
  {
    file: ".ratchet-version",
    label: ".ratchet-version",
    extract(text) {
      const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
      if (!line) {
        throw new VersionLocationError("file is empty — expected a single semver line");
      }
      return line;
    },
  },
  {
    file: join("plugin", ".claude-plugin", "plugin.json"),
    label: "plugin/.claude-plugin/plugin.json",
    extract(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new VersionLocationError(`not valid JSON (${e.message})`);
      }
      if (typeof parsed.version !== "string") {
        throw new VersionLocationError('missing a string "version" field');
      }
      return parsed.version;
    },
  },
  {
    file: "README.md",
    label: "README.md",
    extract(text) {
      const m = /framework-v?(\d+\.\d+\.\d+)/.exec(text);
      if (!m) {
        throw new VersionLocationError("no `framework-vX.Y.Z` shields badge found");
      }
      return m[1];
    },
  },
  {
    file: "DOCS.md",
    label: "DOCS.md",
    extract(text) {
      const m = /^Version\s+(v?\d+\.\d+\.\d+)/m.exec(text);
      if (!m) {
        throw new VersionLocationError("no `Version X.Y.Z` header line found");
      }
      return m[1];
    },
  },
  {
    file: "index.html",
    label: "index.html",
    // The static site carries the version in several places at once — the hero
    // eyebrow and the install/bootstrap commands — so a single `extract` is not
    // enough: every occurrence must agree, and a lone stale one is the exact
    // drift this location exists to catch. `extractAll` returns one raw string
    // per `vMAJOR.MINOR.PATCH` occurrence so each is reported and compared on
    // its own. Throws when the site carries no recognizable version at all.
    extractAll(text) {
      const raws = [...text.matchAll(/v\d+\.\d+\.\d+/g)].map((m) => m[0]);
      if (raws.length === 0) {
        throw new VersionLocationError(
          "no version occurrence found (expected a `vMAJOR.MINOR.PATCH` string)",
        );
      }
      return raws;
    },
  },
];

// Reduce any thrown error to a clear, user-facing message — never a stack trace.
function errorMessage(e) {
  if (e instanceof VersionLocationError) return e.message;
  if (e.code === "ENOENT") return "file not found";
  return e.message;
}

// Turn one raw version string into a record, reporting a non-semver value as an
// `error` rather than throwing so a single bad occurrence never crashes the run.
function toRecord(label, raw) {
  try {
    return { file: label, label, raw, version: normalizeVersion(raw), error: null };
  } catch (e) {
    return { file: label, label, raw, version: null, error: errorMessage(e) };
  }
}

// Read every location under `root` (default: current directory). Returns one
// record per version occurrence: `{ file, label, raw, version, error }`. Most
// locations carry a single occurrence, but a multi-occurrence location (such as
// `index.html`, via `extractAll`) expands to one record per occurrence, each
// labelled `<file> (occurrence N)`, so a lone drifted copy is reported on its
// own. On any failure (missing file, absent marker, non-semver) `error` is a
// clear message string and `raw`/`version` are null; otherwise `error` is null.
// Never throws — the caller decides how to present the collected errors.
export function readVersions(root = ".") {
  const records = [];
  for (const loc of VERSION_LOCATIONS) {
    let text;
    try {
      text = readFileSync(join(root, loc.file), "utf8");
    } catch (e) {
      records.push({ file: loc.label, label: loc.label, raw: null, version: null, error: errorMessage(e) });
      continue;
    }
    if (loc.extractAll) {
      try {
        const raws = loc.extractAll(text);
        raws.forEach((raw, i) => records.push(toRecord(`${loc.label} (occurrence ${i + 1})`, raw)));
      } catch (e) {
        records.push({ file: loc.label, label: loc.label, raw: null, version: null, error: errorMessage(e) });
      }
    } else {
      try {
        records.push(toRecord(loc.label, loc.extract(text)));
      } catch (e) {
        records.push({ file: loc.label, label: loc.label, raw: null, version: null, error: errorMessage(e) });
      }
    }
  }
  return records;
}

// Summarise whether every location carries the same version. `consistent` is
// true only when nothing failed to read AND all normalized versions are equal.
// `version` is the agreed version when consistent, else null.
export function consistencyReport(root = ".") {
  const entries = readVersions(root);
  const errors = entries.filter((e) => e.error);
  const versions = new Set(entries.filter((e) => !e.error).map((e) => e.version));
  return {
    entries,
    errors,
    consistent: errors.length === 0 && versions.size <= 1,
    version: versions.size === 1 ? [...versions][0] : null,
  };
}

// The version the most locations carry — the consensus a lone drifted file
// should be aligned to. Ties keep the first-seen version, so the report is
// deterministic. Errored entries have no version and are ignored here.
function majorityVersion(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e.version) continue;
    counts.set(e.version, (counts.get(e.version) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [version, count] of counts) {
    if (count > bestCount) {
      best = version;
      bestCount = count;
    }
  }
  return best;
}

// Format the check outcome as (exitCode, lines). Pure, so a test can assert on
// the exact message without spawning a process.
export function reportLines(report) {
  if (report.errors.length > 0) {
    const lines = ["Version consistency check could not read every version:"];
    for (const e of report.errors) lines.push(`  ${e.file}: ${e.error}`);
    lines.push("Fix or restore each location above, then re-run the check.");
    return { code: 1, lines };
  }
  if (report.consistent) {
    return { code: 0, lines: [`All framework version strings agree: ${report.version}`] };
  }
  // The expected version is the one the most locations agree on (the majority);
  // ties break toward the first-seen version. Each disagreeing location is then
  // named with the version it carries next to that expected version, so a reader
  // sees exactly which file drifted and to what it should be aligned.
  const expected = majorityVersion(report.entries);
  const lines = [`Framework version strings disagree (expected ${expected}):`];
  for (const e of report.entries) {
    const drift = e.version === expected ? "" : ` — expected ${expected}`;
    lines.push(`  ${e.file}: ${e.raw} (${e.version})${drift}`);
  }
  lines.push(`Align every location to ${expected} (MAJOR.MINOR.PATCH) before opening a PR.`);
  return { code: 1, lines };
}

// --- CLI guard ----------------------------------------------------------
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const root = process.env.VERSION_ROOT || ".";
  const { code, lines } = reportLines(consistencyReport(root));
  const write = code === 0 ? console.log : console.error;
  for (const line of lines) write(line);
  process.exit(code);
}

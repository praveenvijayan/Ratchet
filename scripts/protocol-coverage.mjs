#!/usr/bin/env node
// protocol-coverage.mjs — structural drift guard for the AGENTS.md kernel.
//
// Compressing the manual into an always-loaded kernel (#334) created a drift
// risk: a routing-table entry can point at a deleted file, a required invariant
// marker can vanish in a later edit, and a `scripts/ratchet-*.mjs` command named
// in the kernel can be renamed out from under it. This gate fails the build when
// the kernel and the artifacts it defers to disagree. It asserts against
// machine-readable markers only (backticked paths in the routing table,
// `<!-- ratchet:invariant:<id> -->` comments, `scripts/ratchet-*.mjs` literals),
// never loose English phrases. Mirror parity stays owned by skill-parity.mjs;
// this gate does not duplicate it.
//
// Zero dependencies. Requires Node 20+. Run: node scripts/protocol-coverage.mjs
// Override inputs for testing: AGENTS_FILE=/path REPO_ROOT=/dir.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The checked-in list of invariant ids the kernel must always carry — one per
// hard rule (0–8). A required id whose `<!-- ratchet:invariant:<id> -->` marker
// is absent from AGENTS.md is drift: the safety rule was edited away.
export const REQUIRED_INVARIANTS = [
  "no-issue-no-edits",
  "plan-source",
  "claim-ref",
  "criteria-only",
  "never-red-pr",
  "one-pr",
  "never-merge",
  "labelled-exit",
  "error-paths",
];

// Extract the `## Routing table` section: every line from that heading up to the
// next `## ` heading. Empty string when the kernel has no routing table.
function routingSection(agentsText = "") {
  const lines = String(agentsText).split("\n");
  const start = lines.findIndex((l) => /^##\s+Routing table\b/i.test(l));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// The file paths the routing table routes each concern to: the backticked
// tokens in the "Read this file" column (the last cell of each table row).
// Only the file column is read, so a glob like `plan/*.md` living in the concern
// column is never treated as a routed file. A token counts as a path when it
// contains a "/" or ends in a file extension.
export function routedFilePaths(agentsText = "") {
  const section = routingSection(agentsText);
  const paths = [];
  const seen = new Set();
  for (const line of section.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // Drop the leading/trailing empties produced by the outer pipes.
    const inner = cells.slice(1, -1);
    if (inner.length < 2) continue;
    const fileCell = inner[inner.length - 1];
    // Skip the header row and the |---| separator row.
    if (/^-+$/.test(fileCell.replace(/[:\s|-]/g, "")) && fileCell.includes("-")) continue;
    if (/^Read this file$/i.test(fileCell)) continue;
    for (const m of fileCell.matchAll(/`([^`]+)`/g)) {
      const token = m[1].trim();
      if (!/\/|\.[a-z0-9]+$/i.test(token)) continue;
      if (token.includes("*")) continue; // globs are not concrete files
      if (seen.has(token)) continue;
      seen.add(token);
      paths.push(token);
    }
  }
  return paths;
}

// Routed paths that do not exist on disk under rootDir.
export function missingRoutedFiles(agentsText = "", rootDir = ".") {
  return routedFilePaths(agentsText).filter((p) => !existsSync(join(rootDir, p)));
}

// The invariant ids actually marked in the kernel.
export function markedInvariants(agentsText = "") {
  const ids = new Set();
  for (const m of String(agentsText).matchAll(/<!--\s*ratchet:invariant:([a-z0-9-]+)\s*-->/g)) {
    ids.add(m[1]);
  }
  return [...ids];
}

// Required invariant ids whose marker is missing from the kernel.
export function missingInvariants(agentsText = "", required = REQUIRED_INVARIANTS) {
  const present = new Set(markedInvariants(agentsText));
  return required.filter((id) => !present.has(id));
}

// The `scripts/ratchet-*.mjs` command files the kernel names.
export function referencedScripts(agentsText = "") {
  const seen = new Set();
  for (const m of String(agentsText).matchAll(/scripts\/ratchet-[a-z0-9-]+\.mjs/g)) {
    seen.add(m[0]);
  }
  return [...seen];
}

// Referenced `scripts/ratchet-*.mjs` files that do not exist on disk.
export function missingScripts(agentsText = "", rootDir = ".") {
  return referencedScripts(agentsText).filter((p) => !existsSync(join(rootDir, p)));
}

// All structural violations, uniformly shaped for reporting. Each entry names
// the offender and the file path (or marker) that disagrees with the kernel.
export function protocolViolations(agentsText = "", rootDir = ".", required = REQUIRED_INVARIANTS) {
  const violations = [];
  for (const path of missingRoutedFiles(agentsText, rootDir)) {
    violations.push({ kind: "route", offender: path, detail: `routing table routes to missing file ${path}` });
  }
  for (const id of missingInvariants(agentsText, required)) {
    violations.push({ kind: "invariant", offender: id, detail: `required invariant marker <!-- ratchet:invariant:${id} --> is absent from AGENTS.md` });
  }
  for (const path of missingScripts(agentsText, rootDir)) {
    violations.push({ kind: "script", offender: path, detail: `AGENTS.md names command ${path} but no such script file exists` });
  }
  return violations;
}

const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const agentsFile = process.env.AGENTS_FILE || "AGENTS.md";
  const repoRoot = process.env.REPO_ROOT || dirname(agentsFile) || ".";

  if (!existsSync(agentsFile)) {
    console.error(`AGENTS.md not found: ${agentsFile}. Cannot check protocol coverage.`);
    process.exit(1);
  }

  let agentsText;
  try {
    agentsText = readFileSync(agentsFile, "utf8");
  } catch (e) {
    console.error(`Could not read ${agentsFile}: ${e.message}`);
    process.exit(1);
  }

  const violations = protocolViolations(agentsText, repoRoot);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`::error::protocol-coverage: ${v.detail}`);
    }
    console.error(
      `${violations.length} protocol-coverage violation(s) in ${agentsFile}: the kernel and its ` +
        `deferred artifacts disagree. Fix the offender(s) named above.`,
    );
    process.exit(1);
  }
  console.log(
    `AGENTS.md protocol coverage OK: ${routedFilePaths(agentsText).length} routed file(s), ` +
      `${REQUIRED_INVARIANTS.length} invariant marker(s), ` +
      `${referencedScripts(agentsText).length} ratchet script(s) all resolve.`,
  );
}

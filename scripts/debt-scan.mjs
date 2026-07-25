#!/usr/bin/env node
// debt-scan.mjs — deferred scope must become plan files.
//
// Deferral disclosure is honest, but nothing consumed it: a merged PR could say
// "deferred scope: X" and X never became a plan file, so the debt resurfaced as
// an emergency. This scan makes ingestion mandatory and runs as a check on the
// planning PR.
//
// It stays framework-agnostic. It reads Ratchet's own protocol surface — a
// `## Deferred scope` section in a MERGED PR body, one `-` bullet per deferral —
// plus an OPTIONAL host-configured source-marker regex. No project-specific
// comment convention (`TODO`, `FIXME`, `@defer`, …) is assumed: with no
// `deferral_marker` configured the source scan does not run at all.
//
// Config lives in the `## Deferred-scope debt scan` section of GATES.md and is
// read from the PR's own checkout, NOT the base branch — unlike the size and
// framework-path config, retiring a deferral is an act the author must be able
// to perform in the very PR the check is failing. The trade is deliberate: a
// retirement is a diff line the reviewer sees, on the record.
//
// Zero dependencies. Node 20+ (ESM).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

// Host config. `deferral_marker` absent (or `none`) means the source scan is
// skipped entirely; `retired_deferrals` lists PR numbers whose deferrals a human
// has decided will never be built.
export function readConfig(text) {
  const marker = text.match(/^-\s*deferral_marker:\s*(.+)$/m)?.[1].trim();
  const listed = text.match(/^-\s*retired_deferrals:\s*\[(.*)\]$/m)?.[1] || "";
  return {
    marker: !marker || marker === "none" ? null : marker,
    retired: new Set(listed.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean)),
  };
}

// The deferrals declared by one PR body: every `-` bullet under a
// `## Deferred scope` heading, up to the next heading. Pure and total.
export function deferrals(body) {
  const lines = (body || "").split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+deferred scope\s*$/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (item) out.push(item[1]);
  }
  return out;
}

// The PR numbers some plan file already ingests. The covering mechanism is a
// plain body line, not frontmatter, so covering a deferral never changes what
// plan-sync compiles.
export function coveredPrs(planTexts) {
  const covered = new Set();
  for (const text of planTexts) {
    for (const m of text.matchAll(/Ingests deferred scope from ((?:#\d+[\s,]*)+)/gi)) {
      for (const n of m[1].matchAll(/\d+/g)) covered.add(n[0]);
    }
  }
  return covered;
}

// Active plans and archived ones both count: a deferral covered by work that has
// already shipped is not outstanding debt.
function planFiles(cwd) {
  const out = [];
  for (const dir of ["plan", join("plan", "done")]) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (name.endsWith(".md") && name !== "README.md") out.push({ slug: name.replace(/\.md$/, ""), path: join(abs, name) });
    }
  }
  return out;
}

const trackedFiles = (cwd) =>
  execFileSync("git", ["ls-files"], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\n").filter(Boolean);

// Source markers, only when the host configured a pattern. The pattern must
// capture the plan slug it defers to (group 1); a marker whose slug resolves to
// no plan file is outstanding debt and is reported with file:line.
function scanSources(cwd, pattern, slugs, listFiles) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`deferral_marker in GATES.md is not a valid regular expression (${e.message}). Fix the pattern or set it to 'none'.`);
  }
  // `pattern|` matches the empty string, so the exec result's length reveals the
  // capture-group count without needing a sample that matches.
  if (new RegExp(`${pattern}|`).exec("").length - 1 < 1) {
    throw new Error("deferral_marker must capture the plan slug it defers to as group 1, e.g. 'DEFERRED\\(([\\w-]+)\\)'.");
  }
  const findings = [];
  for (const file of listFiles(cwd)) {
    if (file.startsWith("plan/") || file === "GATES.md") continue;   // the ledgers themselves
    let text;
    try {
      text = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;   // deleted, binary or unreadable — never a reason to fail the scan
    }
    text.split("\n").forEach((line, i) => {
      const m = re.exec(line);
      if (m && !slugs.has(m[1])) findings.push({ where: `${file}:${i + 1}`, what: m[1] ? `marker defers to '${m[1]}'` : "marker names no plan slug" });
    });
  }
  return findings;
}

export async function main({ auth = resolveAuth, fetchImpl = fetch, cwd = process.cwd(), listFiles = trackedFiles, gatesFile = "GATES.md" } = {}) {
  const config = readConfig(existsSync(join(cwd, gatesFile)) ? readFileSync(join(cwd, gatesFile), "utf8") : "");
  const plans = planFiles(cwd);
  const slugs = new Set(plans.map((p) => p.slug));
  const covered = coveredPrs(plans.map((p) => readFileSync(p.path, "utf8")));

  const { token, repo } = auth();
  const gh = ghClient(token, { fetchImpl });
  const closed = await paginate(gh, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, { cap: 200 });

  const unplanned = [];
  for (const pr of closed) {
    if (!pr.merged_at) continue;
    const number = String(pr.number);
    if (config.retired.has(number)) continue;
    if (covered.has(number)) continue;
    for (const item of deferrals(pr.body)) unplanned.push({ pr: pr.number, item });
  }

  const markers = config.marker ? scanSources(cwd, config.marker, slugs, listFiles) : [];
  if (!config.marker) console.log("No deferral_marker configured in GATES.md — the source scan is skipped (no default marker convention is assumed).");

  if (!unplanned.length && !markers.length) {
    console.log(`debt-scan: no unplanned deferred scope (${closed.filter((p) => p.merged_at).length} merged PR(s) scanned).`);
    return { unplanned, markers };
  }

  console.error("ERROR: deferred scope has not been turned into plan files.");
  console.error("");
  for (const { pr, item } of unplanned) {
    console.error(`  • PR #${pr} deferred: ${item}`);
    console.error(`      cover  — add a plan/*.md to this PR whose body says: Ingests deferred scope from #${pr}`);
    console.error(`      retire — add ${pr} to 'retired_deferrals' in GATES.md, saying why in this PR`);
  }
  for (const { where, what } of markers) {
    console.error(`  • ${where} — ${what}, which is not a plan file`);
    console.error(`      cover  — add the plan/*.md that slug names, in this PR`);
    console.error(`      retire — delete the marker, or point it at an existing plan slug`);
  }
  console.error("");
  console.error("Both mechanisms are documented in plan/README.md ('Ingesting deferred scope').");
  const err = new Error(`${unplanned.length + markers.length} unplanned deferral(s)`);
  err.findings = { unplanned, markers };
  throw err;
}

// Auto-run only when executed directly, never on import (the test drives main()).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    if (!e.findings) console.error(e.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
// archive-closed-plans.mjs — the dedicated "archive closed plans" sweep.
// Moves every plan/*.md whose issue is CLOSED into plan/done/, so the active
// plan/ directory stays a map of live work while the history is preserved on
// disk (and in git). Noise otherwise grows linearly with project age.
//
// Safe by design: plan-sync resolves every blocker through the issue's
// `<!-- plan-id: slug -->` marker, not the file's presence, so archiving a file
// never breaks a `blocked_by` pointing at it (see plan-sync + its regression
// test). plan-sync also never scans plan/done/, so an archived file is inert.
//
// Run:  node scripts/archive-closed-plans.mjs
// It only MOVES files into plan/done/ — it never commits or pushes. Review the
// moves (git shows them as renames) and commit them like any other change, so
// the archive lands as one reviewable commit through the normal PR flow.
//
// Zero dependencies. Requires Node 20+ (global fetch). Token/repo resolution is
// identical to plan-sync: GITHUB_TOKEN | GITHUB_PAT (.env or env), and
// GITHUB_REPOSITORY = "owner/repo".

import { readdir, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

// Token/repo (from GITHUB_TOKEN | GITHUB_PAT and GITHUB_REPOSITORY, environment
// or .env) and the shared REST client. Resolved at load so a missing credential
// fails before any file is moved, exactly as before.
const { token, repo: REPO } = resolveAuth();
const gh = ghClient(token);
const PLAN_DIR = process.env.PLAN_DIR || "plan";

async function listAllIssues() {
  const all = await paginate(gh, `/repos/${REPO}/issues?state=all`);
  return all.filter((i) => !i.pull_request);
}

async function main() {
  // Top-level *.md only — plan/done/ is never scanned (mirrors plan-sync), so a
  // second run only picks up newly-closed plans, never re-touches the archive.
  const entries = await readdir(PLAN_DIR, { withFileTypes: true });
  const planFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name);

  // Map each plan-id slug to its issue state via the marker. state=all so closed
  // issues are visible; a slug with no issue (never synced) is simply unknown.
  const issues = await listAllIssues();
  // A slug can appear on more than one issue (a split, a reopen-and-refile, a
  // hand-authored duplicate). A file is only safe to archive when the work it
  // describes is *entirely* done: at least one issue carries the marker and
  // every issue that carries it is closed. So track open and closed markers
  // separately — a single open issue vetoes the archive regardless of how many
  // closed ones share the slug — instead of letting a last-writer-wins Map hand
  // the decision to whichever issue happened to be listed last.
  const openSlugs = new Set();
  const closedSlugs = new Set();
  for (const issue of issues) {
    const m = (issue.body || "").match(/<!-- plan-id: (.+?) -->/);
    if (!m) continue;
    (issue.state === "closed" ? closedSlugs : openSlugs).add(m[1]);
  }

  const toArchive = planFiles.filter((f) => {
    const slug = f.replace(/\.md$/, "");
    return closedSlugs.has(slug) && !openSlugs.has(slug);
  });
  if (!toArchive.length) {
    console.log("Nothing to archive: no active plan file maps to a closed issue.");
    return;
  }

  const doneDir = join(PLAN_DIR, "done");
  await mkdir(doneDir, { recursive: true });
  let failed = 0;
  for (const f of toArchive) {
    const src = join(PLAN_DIR, f);
    const dest = join(doneDir, f);
    // rename() silently overwrites its destination on POSIX, so a name clash in
    // plan/done/ would replace already-archived history without a trace. Guard
    // it explicitly: refuse the move, name both paths, and leave the source in
    // place. The run keeps going and exits non-zero.
    if (existsSync(dest)) {
      failed++;
      console.error(`ERROR: could not archive ${f}: destination ${dest} already exists — refusing to overwrite archived history. Source ${src} left in place.`);
      continue;
    }
    try {
      await rename(src, dest);
      console.log(`ARCHIVE ${f} -> done/${f}`);
    } catch (e) {
      // Any other unmovable file (permissions, cross-device) must not abort the
      // rest — report it loudly and keep going; the run exits non-zero.
      failed++;
      console.error(`ERROR: could not archive ${f}: ${e.message}`);
    }
  }
  const moved = toArchive.length - failed;
  console.log(`\nMoved ${moved} closed plan file(s) into ${doneDir}.`);
  console.log("Review the renames and commit them — the archive lands as one reviewable commit.");
  if (failed) process.exit(1);
}

// Top-level await (not .catch()) so a test that dynamically imports this module
// resumes only after the sweep has fully finished.
try {
  await main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

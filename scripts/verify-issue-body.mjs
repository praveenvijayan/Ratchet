#!/usr/bin/env node
// verify-issue-body.mjs — integrity check for the unattended runner.
// `ratchet-run` feeds an issue body to an agent holding a write-scoped PAT, so
// a body edited after the plan was reviewed becomes untrusted instructions.
// This module decides whether an issue body still matches the reviewed plan
// file it was compiled from. The decision is pure and unit-tested; the workflow
// supplies the plan text and acts on the verdict. Zero dependencies.
//
// CLI mode (used by .github/workflows/ratchet-run.yml):
//   ISSUE_BODY_FILE=body.md ISSUE_TITLE_FILE=title.txt ISSUE_NUMBER=12 ISSUES_FILE=issues.json PLAN_DIR=plan node scripts/verify-issue-body.mjs
//   exit 0 + "VERIFIED ..." when safe to run; exit 1 + reason when it must skip.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { planSlug, isPlanMarkerLine } from "./criteria.mjs";

export { planSlug };

// A plan slug is a filename stem (see plan/README.md): lowercase letters and
// digits in hyphen-joined segments, e.g. `0030-runner-title-comment-trust-boundary`.
// The slug is attacker-influenced text (it comes from the mutable issue body) and
// is joined into a filesystem path, so anything outside this charset — a dot, a
// slash, `..`, uppercase, whitespace — is rejected before it can touch the disk.
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isSafeSlug(slug) {
  return typeof slug === "string" && SAFE_SLUG.test(slug);
}

// The plan file's `title:` frontmatter value — exactly what plan-sync compiles
// into the issue title. Mirrors plan-sync's parsePlan scalar-key handling (strip
// an inline `# comment`, trim, strip one layer of surrounding quotes) so a
// verified title matches byte-for-byte what a reviewer approved. null when the
// frontmatter is absent or carries no title.
export function planTitle(planText) {
  const m = String(planText).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv || kv[1] !== "title") continue;
    return kv[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// The plan file's authored content: everything below the frontmatter, trimmed.
// Mirrors plan-sync's parsePlan body extraction exactly.
export function planBody(planText) {
  const m = String(planText).match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return (m ? m[1] : String(planText)).trim();
}

// The human-authored core of an issue body: the compiled body with the
// plan-id marker and the trailing `Blocked by #N` block (both machine-appended
// by plan-sync) removed, so what remains is exactly what a reviewer approved.
export function issueCore(issueBody) {
  let lines = String(issueBody).replace(/\r\n/g, "\n").split("\n");
  lines = lines.filter((l) => !isPlanMarkerLine(l));
  const isBlank = (l) => l.trim() === "";
  const isBlocker = (l) => /^\s*Blocked by #\d+\s*$/.test(l);
  while (lines.length && (isBlank(lines[lines.length - 1]) || isBlocker(lines[lines.length - 1]))) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

function normalize(s) {
  return String(s).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

// Does the compiled issue body still match its reviewed plan file?
export function bodyMatchesPlan(issueBody, planText) {
  return normalize(planBody(planText)) === normalize(issueCore(issueBody));
}

// Does the issue title still match the reviewed plan's `title:` frontmatter?
// The title is a second mutable channel into the agent, so it is verified the
// same way the body is: any drift from the plan means it was edited after review.
export function titleMatchesPlan(issueTitle, planText) {
  return normalize(planTitle(planText)) === normalize(issueTitle);
}

// Bind a plan slug to the issue that plan-sync created for it. The issue body is
// mutable, so a different issue can copy a reviewed plan's marker and content.
// Given the GitHub issue index, exactly one issue may carry the slug and it must
// be the picked issue.
export function issueMatchesPlanSlug(issueNumber, issueBody, issues = []) {
  const current = Number(issueNumber);
  if (!Number.isInteger(current) || current <= 0) {
    return { ok: false, reason: "ISSUE_NUMBER is required to bind the reviewed plan slug to the picked issue" };
  }
  const slug = planSlug(issueBody);
  const matches = issues
    .filter((issue) => planSlug(issue.body || "") === slug)
    .map((issue) => Number(issue.number))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
  if (!matches.includes(current)) {
    const where = matches.length ? `issue #${matches.join(", #")}` : "no issue in the provided GitHub issue index";
    return { ok: false, reason: `plan-id slug \`${slug}\` is bound to ${where}, not picked issue #${current}; refusing this issue/plan mismatch` };
  }
  if (matches.length !== 1) {
    return { ok: false, reason: `plan-id slug \`${slug}\` appears on multiple issues (#${matches.join(", #")}); refusing this issue/plan mismatch` };
  }
  return { ok: true };
}

// The full verdict the runner acts on. `planText` is null when no plan file
// exists for the slug; `issueTitle` is the issue's current title. Returns
// { verified, reason, slug? }. Every path fails closed — an unverifiable or
// edited body, title, or slug refuses the run rather than trusting it.
export function verify(issueBody, planText, issueTitle, options = {}) {
  const slug = planSlug(issueBody);
  if (!slug) {
    return { verified: false, reason: "issue body carries no `plan-id` marker; the runner only works issues compiled from a reviewed plan file" };
  }
  if (!isSafeSlug(slug)) {
    return { verified: false, reason: `\`plan-id\` slug \`${slug}\` contains characters outside the safe slug charset (lowercase letters, digits, hyphen-joined segments); refusing to run on an unverifiable, path-unsafe slug`, slug };
  }
  if (planText == null) {
    return { verified: false, reason: `no plan file \`plan/${slug}.md\` found on main to verify against; refusing to run on an unverifiable issue`, slug };
  }
  if (options.issueNumber != null || options.issues != null) {
    const binding = issueMatchesPlanSlug(options.issueNumber, issueBody, options.issues || []);
    if (!binding.ok) {
      return { verified: false, reason: binding.reason, slug };
    }
  }
  if (!bodyMatchesPlan(issueBody, planText)) {
    return { verified: false, reason: `issue body no longer matches \`plan/${slug}.md\` — it was edited after compilation. Re-sync from the plan file, or revert the edit, to re-enable automation`, slug };
  }
  if (!titleMatchesPlan(issueTitle, planText)) {
    return { verified: false, reason: `issue title no longer matches the \`title:\` in \`plan/${slug}.md\` — it was edited after compilation. The title is never work instructions; re-sync from the plan file, or revert the edit, to re-enable automation`, slug };
  }
  return { verified: true, reason: `issue body and title match \`plan/${slug}.md\``, slug };
}

// --- CLI entry: only when executed directly, never when imported by a test ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bodyFile = process.env.ISSUE_BODY_FILE;
  const titleFile = process.env.ISSUE_TITLE_FILE;
  const issueNumber = process.env.ISSUE_NUMBER;
  const issuesFile = process.env.ISSUES_FILE;
  const planDir = process.env.PLAN_DIR || "plan";
  if (!bodyFile || !existsSync(bodyFile)) {
    console.error(`ISSUE_BODY_FILE not found: ${bodyFile || "(unset)"}`);
    process.exit(1);
  }
  const issueBody = readFileSync(bodyFile, "utf8");
  const issueTitle = titleFile && existsSync(titleFile) ? readFileSync(titleFile, "utf8").trim() : "";
  const slug = planSlug(issueBody);
  // Only join the slug into a path once it is known safe — an unsafe slug is
  // attacker-influenced text and must never reach the filesystem. verify() also
  // re-checks the charset, so the skip reason is identical whether or not a file
  // happened to exist at a traversed path.
  const planPath = isSafeSlug(slug) ? join(planDir, `${slug}.md`) : null;
  const planText = planPath && existsSync(planPath) ? readFileSync(planPath, "utf8") : null;
  let issues;
  if (issuesFile) {
    if (!existsSync(issuesFile)) {
      console.error(`ISSUES_FILE not found: ${issuesFile}`);
      process.exit(1);
    }
    try {
      issues = JSON.parse(readFileSync(issuesFile, "utf8"));
    } catch (err) {
      console.error(`ISSUES_FILE is not valid JSON: ${err.message}`);
      process.exit(1);
    }
  }
  const { verified, reason } = verify(issueBody, planText, issueTitle, { issueNumber, issues });
  console.log(verified ? `VERIFIED: ${reason}` : `SKIP: ${reason}`);
  process.exit(verified ? 0 : 1);
}

#!/usr/bin/env node
// verify-issue-body.mjs — integrity check for the unattended runner.
// `ratchet-run` feeds an issue body to an agent holding a write-scoped PAT, so
// a body edited after the plan was reviewed becomes untrusted instructions.
// This module decides whether an issue body still matches the reviewed plan
// file it was compiled from. The decision is pure and unit-tested; the workflow
// supplies the plan text and acts on the verdict. Zero dependencies.
//
// CLI mode (used by .github/workflows/ratchet-run.yml):
//   ISSUE_BODY_FILE=/path/to/body.md PLAN_DIR=plan node scripts/verify-issue-body.mjs
//   exit 0 + "VERIFIED ..." when safe to run; exit 1 + reason when it must skip.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { planSlug } from "./criteria.mjs";

export { planSlug };

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
  lines = lines.filter((l) => !/^\s*<!--\s*plan-id:\s*.+?\s*-->\s*$/.test(l));
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

// The full verdict the runner acts on. `planText` is null when no plan file
// exists for the slug. Returns { verified, reason, slug? }.
export function verify(issueBody, planText) {
  const slug = planSlug(issueBody);
  if (!slug) {
    return { verified: false, reason: "issue body carries no `plan-id` marker; the runner only works issues compiled from a reviewed plan file" };
  }
  if (planText == null) {
    return { verified: false, reason: `no plan file \`plan/${slug}.md\` found on main to verify against; refusing to run on an unverifiable issue`, slug };
  }
  if (!bodyMatchesPlan(issueBody, planText)) {
    return { verified: false, reason: `issue body no longer matches \`plan/${slug}.md\` — it was edited after compilation. Re-sync from the plan file, or revert the edit, to re-enable automation`, slug };
  }
  return { verified: true, reason: `issue body matches \`plan/${slug}.md\``, slug };
}

// --- CLI entry: only when executed directly, never when imported by a test ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bodyFile = process.env.ISSUE_BODY_FILE;
  const planDir = process.env.PLAN_DIR || "plan";
  if (!bodyFile || !existsSync(bodyFile)) {
    console.error(`ISSUE_BODY_FILE not found: ${bodyFile || "(unset)"}`);
    process.exit(1);
  }
  const issueBody = readFileSync(bodyFile, "utf8");
  const slug = planSlug(issueBody);
  const planPath = slug ? join(planDir, `${slug}.md`) : null;
  const planText = planPath && existsSync(planPath) ? readFileSync(planPath, "utf8") : null;
  const { verified, reason } = verify(issueBody, planText);
  console.log(verified ? `VERIFIED: ${reason}` : `SKIP: ${reason}`);
  process.exit(verified ? 0 : 1);
}

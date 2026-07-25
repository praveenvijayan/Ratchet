#!/usr/bin/env node
// framework-plan-check.mjs — framework work goes through plans too (#473).
//
// Ratchet's own machinery has been changing outside the loop: #190 landed
// +9,397 lines as a "version update", with no plan file, no criteria and no
// size budget. That second lane exists only because nothing checks for it. This
// gate closes it: a PR touching `scripts/**` or `.github/workflows/**` must
// trace to an issue carrying the plan-id marker plan-sync.mjs stamps on every
// issue it compiles from a `plan/*.md`. No marker, no framework change.
//
// Framework paths come from GATES.md, and pr-gates points BASE_GATES_FILE at
// the base branch's copy (the pr-size-check pattern, #84) so a framework PR
// cannot edit its own config to exempt itself. Emergencies get an explicit
// override: a human with write access adds the `override:framework-plan` label,
// which lands on the record twice — the label event in the PR timeline and the
// sticky comment this check posts naming the paths it let through.
//
// Zero dependencies. Requires Node 20+. Run: node scripts/framework-plan-check.mjs
// Env: PR_NUMBER + GITHUB_TOKEN/GITHUB_REPOSITORY (CI), or the injected
// PR_FILES_JSON / PR_HEAD_REF / PR_BODY / PR_LABELS / ISSUE_BODY (tests).
// Config file overrides: GATES_FILE, BASE_GATES_FILE.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";
// criteria.mjs owns the plan-id marker shape (#345): every consumer reads the
// slug through planSlug, so the marker's grammar lives in exactly one place.
import { planSlug } from "./criteria.mjs";

export const DEFAULT_FRAMEWORK_PATHS = ["scripts/**", ".github/workflows/**"];
export const OVERRIDE_LABEL = "override:framework-plan";
export const COMMENT_MARKER = "<!-- ratchet:framework-plan-check -->";
export const PROTOCOL = "AGENTS.md hard rule 0 and plan/README.md — write a plan/*.md, open a planning PR, let plan-sync compile the issue.";

// `framework_paths:` in GATES.md, inline list or a following `- item` block —
// the same shape pr-size-check.mjs reads `exclude_paths:` in. Absent config
// falls back to the defaults above: the lane must be closed even before a
// project tunes it.
export function readConfig(text = "") {
  const lines = String(text).split("\n");
  const configured = [];
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^\s*-?\s*framework_paths\s*[:=]\s*(.*?)\s*$/i);
    if (!inline) continue;
    const parse = (v) => {
      const raw = v.trim();
      const body = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
      return body.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    };
    configured.push(...parse(inline[1]));
    if (inline[1].trim()) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s+-\s+(.+?)\s*$/);
      if (!item) break;
      configured.push(...parse(item[1]));
    }
  }
  return { frameworkPaths: configured.length ? configured : [...DEFAULT_FRAMEWORK_PATHS] };
}

// Glob-ish matching against the full repo-relative path: `*` stays inside one
// segment, `**` crosses `/`. Same semantics GATES.md documents for exclusions.
function matchesPattern(path, pattern) {
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(path.replace(/\\/g, "/"));
}

export function frameworkHits(files = [], patterns = DEFAULT_FRAMEWORK_PATHS) {
  return files
    .map((f) => (typeof f === "string" ? f : f?.filename || f?.path || ""))
    .filter((p) => p && patterns.some((pattern) => matchesPattern(p, pattern)));
}

// The issue this PR closes: the claim ref names it, and `Closes #<N>` backs
// that up for hand-opened PRs.
export function issueNumberFrom({ headRef = "", body = "" } = {}) {
  const fromRef = String(headRef).match(/agent\/issue-(\d+)/);
  if (fromRef) return Number(fromRef[1]);
  const fromBody = String(body).match(/\b(?:closes|fixes|resolves)\s+#(\d+)/i);
  return fromBody ? Number(fromBody[1]) : 0;
}

export function evaluate({ files = [], patterns, issueNumber = 0, issueBody = "", labels = [] } = {}) {
  const paths = frameworkHits(files, patterns || DEFAULT_FRAMEWORK_PATHS);
  if (!paths.length) {
    return { status: "clean", paths, message: "This PR touches no framework paths — the framework-plan check does not apply." };
  }
  // plan-sync.mjs stamps the marker on every issue it compiles from a plan file.
  const planId = planSlug(issueBody);
  const named = paths.join(", ");
  if (planId) {
    return { status: "pass", paths, planId, message: `Framework paths (${named}) trace to issue #${issueNumber}, plan-id: ${planId}.` };
  }
  const overridden = labels.map((l) => (typeof l === "string" ? l : l?.name || "")).includes(OVERRIDE_LABEL);
  const why = issueNumber
    ? `issue #${issueNumber} carries no <!-- plan-id: ... --> marker`
    : "this PR references no issue (no agent/issue-<N> branch, no `Closes #<N>`)";
  const overrideMessage = `Framework-plan check OVERRIDDEN by the \`${OVERRIDE_LABEL}\` label: ${why}. Paths let through: ${named}.`;
  if (overridden) return { status: "override", paths, message: overrideMessage };
  return {
    status: "fail",
    paths,
    message: [
      `Framework change without a plan: ${why}.`,
      "",
      "Offending paths:",
      ...paths.map((p) => `  - ${p}`),
      "",
      "Framework work gets the same plan files, criteria and size budgets as",
      `product work — there is no version-update lane. ${PROTOCOL}`,
      "",
      `Emergencies only: a human may add the \`${OVERRIDE_LABEL}\` label to this PR;`,
      "the override is recorded in a comment here.",
    ].join("\n"),
  };
}

// One comment per PR, updated in place — the durable half of the override's
// audit trail (the label event in the timeline is the other half).
export const auditComment = (result, prNumber) =>
  `${COMMENT_MARKER}\n### Framework-plan check — override used on PR #${prNumber}\n\n${result.message}\n\nProtocol: ${PROTOCOL}`;

export async function upsertComment(gh, repo, prNumber, body) {
  const comments = await paginate(gh, `/repos/${repo}/issues/${prNumber}/comments`, { cap: 200 });
  const existing = comments.find((c) => (c.body || "").includes(COMMENT_MARKER));
  if (existing) return gh("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  return gh("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body });
}

// Inputs come from env when injected (tests, and the workflow's event payload)
// and from the API otherwise, so the check is a pure function of its inputs.
async function gatherInputs(prNumber) {
  if (process.env.PR_FILES_JSON !== undefined) {
    let files;
    try {
      files = JSON.parse(process.env.PR_FILES_JSON);
    } catch {
      throw new Error("PR_FILES_JSON was not valid JSON.");
    }
    if (!Array.isArray(files)) throw new Error("PR_FILES_JSON must be a JSON array.");
    return {
      gh: null,
      repo: "",
      files,
      headRef: process.env.PR_HEAD_REF || "",
      body: process.env.PR_BODY || "",
      labels: (process.env.PR_LABELS || "").split(",").map((s) => s.trim()).filter(Boolean),
      issueBody: process.env.ISSUE_BODY || "",
      issueKnown: process.env.ISSUE_BODY !== undefined,
    };
  }
  const { token, repo } = resolveAuth();
  const gh = ghClient(token);
  const pr = await gh("GET", `/repos/${repo}/pulls/${prNumber}`);
  const files = await paginate(gh, `/repos/${repo}/pulls/${prNumber}/files`, { cap: 300 });
  return {
    gh,
    repo,
    files,
    headRef: pr?.head?.ref || "",
    body: pr?.body || "",
    labels: pr?.labels || [],
    issueBody: "",
    issueKnown: false,
  };
}

async function main() {
  const prNumber = Number(process.env.PR_NUMBER || 0);
  if (!prNumber) {
    console.error("PR_NUMBER is required — this check runs on a pull_request event. Check the pr-gates workflow wiring.");
    process.exit(2);
  }
  const configFile = process.env.BASE_GATES_FILE || process.env.GATES_FILE || "GATES.md";
  const { frameworkPaths } = readConfig(existsSync(configFile) ? readFileSync(configFile, "utf8") : "");

  const input = await gatherInputs(prNumber);
  const issueNumber = issueNumberFrom({ headRef: input.headRef, body: input.body });
  let issueBody = input.issueBody;
  if (!input.issueKnown && issueNumber && input.gh) {
    // A deleted or inaccessible issue is indistinguishable from an unplanned
    // one for this gate's purposes: no marker readable, no trace.
    try {
      issueBody = (await input.gh("GET", `/repos/${input.repo}/issues/${issueNumber}`))?.body || "";
    } catch {
      issueBody = "";
    }
  }

  const result = evaluate({ files: input.files, patterns: frameworkPaths, issueNumber, issueBody, labels: input.labels });

  if (result.status === "clean" || result.status === "pass") {
    console.log(`::notice::${result.message.split("\n")[0]}`);
    console.log(result.message);
    return;
  }

  if (result.status === "override") {
    const comment = auditComment(result, prNumber);
    console.log(`::warning::${result.message}`);
    console.log(comment);
    if (input.gh) {
      try {
        await upsertComment(input.gh, input.repo, prNumber, comment);
      } catch (e) {
        // A missing write grant (fork PR) must not turn an accepted override
        // into a red build: the record is already on the log and in the label
        // event, so warn rather than fail.
        console.log(`::warning::Could not post the framework-plan override comment on PR #${prNumber} (${e.message}) — the record above still stands.`);
      }
    }
    return;
  }

  console.log(`::error::Framework change without a plan: ${result.paths.join(", ")}.`);
  console.error(result.message);
  process.exit(1);
}

// CLI — run only when invoked directly (robust to spaces in the repo path).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    await main();
  } catch (e) {
    console.error(`Framework-plan check could not run: ${e.message}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
// pr-size-check.mjs — enforce the agent PR size limit mechanically.
//
// AGENTS.md step 3 caps an issue's scope at ~400 changed lines / ~6 files and
// tells the agent to split-and-requeue when it exceeds that. On its own that
// limit is honor-system only, and oversized PRs are the biggest drain on the
// loop's bottleneck resource — human review. This script turns the cap into a
// machine check: the `pr-gates` workflow runs it on every `agent/issue-*` PR
// and a red check names the overflow, quotes the numbers, and repeats the
// split-and-requeue protocol so the agent knows exactly what to do next.
//
// Thresholds live in GATES.md (criterion 3) so they are tuned as project
// config, never hard-coded here; absent config falls back to the manual's
// ~400 lines / ~6 files. PR size comes from the pull_request event payload,
// passed in as env vars so this stays a pure, testable function of its inputs.
//
// Zero dependencies. Requires Node 20+.
//   Run:  PR_ADDITIONS=.. PR_DELETIONS=.. PR_CHANGED_FILES=.. node scripts/pr-size-check.mjs
//   Override the config file for testing with GATES_FILE=/path/to/GATES.md.

import { existsSync, readFileSync, appendFileSync } from "node:fs";

const GATES_FILE = process.env.GATES_FILE || "GATES.md";
const DEFAULT_MAX_LINES = 400; // AGENTS.md step 3
const DEFAULT_MAX_FILES = 6; //   ~400 changed lines / ~6 files

// Best-effort line into the Actions check summary; decorative, never the
// signal (that is the exit code), so a summary hiccup must not mask a result.
function summary(line) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try {
      appendFileSync(f, line + "\n");
    } catch {
      /* summary is decorative; the exit code is the real signal */
    }
  }
}
const notice = (msg) => console.log(`::notice::${msg}`);
const errorAnnot = (msg) => console.log(`::error::${msg}`);

// --- read thresholds from GATES.md (criterion 3) ----------------------------
// Parse `max_changed_lines:` / `max_changed_files:` anywhere in GATES.md. A
// missing file or key falls back to the manual's defaults rather than failing
// — the limit must still be enforced even before a project tunes it.
function readLimits(text) {
  const num = (key, fallback) => {
    const m = text.match(new RegExp(`max_changed_${key}\\s*[:=]\\s*(\\d+)`, "i"));
    return m ? Number(m[1]) : fallback;
  };
  return { maxLines: num("lines", DEFAULT_MAX_LINES), maxFiles: num("files", DEFAULT_MAX_FILES) };
}

const gatesText = existsSync(GATES_FILE) ? readFileSync(GATES_FILE, "utf8") : "";
const { maxLines, maxFiles } = readLimits(gatesText);

// --- read the PR's size from the event payload ------------------------------
// Missing or non-numeric counts mean the workflow wired the check up wrong;
// fail loudly (Hard Rule 8) rather than passing a PR whose size is unknown.
function intFromEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "" || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

const additions = intFromEnv("PR_ADDITIONS");
const deletions = intFromEnv("PR_DELETIONS");
const changedFiles = intFromEnv("PR_CHANGED_FILES");

if (additions === null || deletions === null || changedFiles === null) {
  const msg =
    "PR size check could not determine the PR's size: expected numeric " +
    "PR_ADDITIONS, PR_DELETIONS and PR_CHANGED_FILES (from the pull_request " +
    "event payload). Check the pr-gates workflow wiring.";
  errorAnnot(msg);
  summary(`### PR size\n\n❌ ${msg}`);
  console.error(msg);
  process.exit(1);
}

const changedLines = additions + deletions;
const overLines = changedLines > maxLines;
const overFiles = changedFiles > maxFiles;

if (!overLines && !overFiles) {
  const msg = `PR size OK: ${changedLines} changed line(s) ≤ ${maxLines}, ${changedFiles} file(s) ≤ ${maxFiles}.`;
  notice(msg);
  summary(`### PR size\n\n✅ ${msg}`);
  console.log(msg);
  process.exit(0);
}

// --- over the limit: fail with the numbers and the protocol (criterion 2) ---
const breaches = [
  overLines ? `${changedLines} changed lines (limit ${maxLines})` : null,
  overFiles ? `${changedFiles} files (limit ${maxFiles})` : null,
].filter(Boolean);

const message = [
  `PR size limit exceeded: ${breaches.join(" and ")}.`,
  "",
  "Oversized PRs are the biggest drain on review quality, and review is the",
  "loop's bottleneck. Per AGENTS.md step 3, when scope exceeds the issue",
  `(~${maxLines} changed lines or ~${maxFiles} files), split and requeue:`,
  "  1. comment a proposed split on the issue,",
  "  2. reset it to state:ready and remove state:in-progress,",
  "  3. exit — the split becomes new plan/*.md files or issues.",
  "",
  `Thresholds are configured in ${GATES_FILE} (max_changed_lines / max_changed_files).`,
].join("\n");

errorAnnot(`PR size limit exceeded: ${breaches.join("; ")}.`);
summary(`### PR size\n\n❌ ${message.replace(/\n/g, "\n")}`);
console.error(message);
process.exit(1);

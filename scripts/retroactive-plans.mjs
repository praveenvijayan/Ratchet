#!/usr/bin/env node
// retroactive-plans.mjs — flag plans whose work already exists (#471).
//
// Plan-before-code is hard rule 0, but it breaks silently for side-branch work
// (#229/#235): code lands first, a plan papers over it afterwards, and it syncs
// as ordinary `state:ready` work. Two callers share this detector: the
// planning-PR check (the CLI below, run by .github/workflows/pr-gates.yml)
// comments on the PR naming each added plan file and the branch/PR it matches;
// plan-sync.mjs syncs a matched plan `state:draft` (unpickable) unless its
// frontmatter carries an explicit `retroactive_ok:`. Detection is normalised
// containment of the slug or title — nothing fuzzy — so every flag quotes the
// text that caused it.
//
// Zero dependencies. Requires Node 20+. Run: node scripts/retroactive-plans.mjs
// Env: GITHUB_TOKEN (or GITHUB_PAT), GITHUB_REPOSITORY, PR_NUMBER.

import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";

// Approval is a plan-file edit on purpose: it lives in git history and in the
// planning PR that merged it, not in a chat message nobody can find later.
export const APPROVAL_KEY = "retroactive_ok";
// Markers keep each comment single: updated in place, never re-posted.
export const COMMENT_MARKER = "<!-- ratchet:retroactive-check -->";
export const auditMarker = (slug, kind) => `<!-- ratchet:retroactive:${slug}:${kind} -->`;
// Shorter than this, a string is too generic to be evidence ("fix", "ui").
export const MIN_NEEDLE = 8;

// Fold text into one shape: `feature/No Retro Plans!` -> `no-retro-plans`.
export const normalizeRef = (text = "") => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Drop the ordering prefix: branch names carry no plan numbering.
export const slugBody = (slug = "") => normalizeRef(String(slug).replace(/^\d+[-_]/, ""));

const oneLine = (text, max = 160) => String(text).replace(/\s+/g, " ").trim().slice(0, max);

// What to search for, each keeping the human-readable form to quote back.
export function needlesFor({ slug = "", title = "" } = {}) {
  const body = slugBody(slug);
  const normTitle = normalizeRef(title);
  return [
    ...(body.length >= MIN_NEEDLE ? [{ kind: "slug", value: body, shown: slug }] : []),
    ...(normTitle.length >= MIN_NEEDLE && normTitle !== body ? [{ kind: "title", value: normTitle, shown: title }] : []),
  ];
}

// Short fields (branch name, PR title) match either way round — the plan may be
// named after the branch or the branch after it. A PR body is prose: one-way
// containment, quoting the matching line rather than the whole body.
function matchText(text, needle, multiline) {
  for (const line of multiline ? String(text || "").split("\n") : [text]) {
    const norm = normalizeRef(line);
    if (norm.length < MIN_NEEDLE) continue;
    if (norm.includes(needle.value) || (!multiline && needle.value.includes(norm))) return oneLine(line);
  }
  return null;
}

// Live branches and open PRs as references; `excludeBranch`/`excludePr` drop the
// planning PR, or every plan would flag itself.
export function buildRefs({ branches = [], pulls = [], excludeBranch = "", excludePr = 0 } = {}) {
  const refs = [];
  for (const b of branches) {
    const name = typeof b === "string" ? b : b?.name;
    if (name && name !== excludeBranch) refs.push({ label: `branch \`${name}\``, fields: [{ name: "the branch name", text: name }] });
  }
  for (const p of pulls) {
    const head = p?.head?.ref || "";
    if (!p || Number(p.number) === Number(excludePr) || (head && head === excludeBranch)) continue;
    refs.push({
      label: `PR #${p.number} (${oneLine(p.title || "untitled", 80)})`,
      fields: [
        { name: "the PR title", text: p.title || "" },
        { name: "the PR head branch", text: head },
        { name: "the PR body", text: p.body || "", multiline: true },
      ],
    });
  }
  return refs;
}

// One line of evidence per matching branch/PR.
export function matchPlan(plan, refs = []) {
  const needles = needlesFor(plan);
  const out = [];
  for (const ref of needles.length ? refs : []) {
    let hit = null;
    for (const field of ref.fields) {
      for (const needle of needles) {
        const quote = matchText(field.text, needle, field.multiline);
        if (quote) { hit = { label: ref.label, field: field.name, needle, quote }; break; }
      }
      if (hit) break;
    }
    if (hit) out.push(hit);
  }
  return out;
}

// One sentence per flag, naming and quoting what matched — never a bare failure.
export const describeMatch = (m) => `plan ${m.needle.kind} \`${oneLine(m.needle.shown, 80)}\` matches ${m.field} of ${m.label}: \`${m.quote}\``;

const approvalHowTo = (where) =>
  `**To approve** (the work legitimately predates the write-up — a spike, a hotfix, an experiment): add ` +
  `\`${APPROVAL_KEY}: <why>\` to the plan's frontmatter ${where}. \`plan-sync\` then syncs the plan as ordinary ready ` +
  `work and records the approval on the issue. Avoid \`#\` in the note — the frontmatter parser reads it as a comment.`;

// The single comment the planning-PR check owns.
export function formatCheckComment(flags = []) {
  if (!flags.length) {
    return `${COMMENT_MARKER}\n\n### Retroactive plan check — clear\n\nNo plan file added by this PR matches an existing branch or PR. Every plan here syncs normally.`;
  }
  const listed = flags.map((f) => [`- **\`${f.file}\`**`, ...f.matches.map((m) => `  - ${describeMatch(m)}`)].join("\n"));
  return [COMMENT_MARKER,
    `### Retroactive plan check — ${flags.length} plan(s) may describe work that already exists`,
    "Plan-before-code is hard rule 0 in `AGENTS.md`. Each plan file below matches a branch or PR that already exists, so its code may predate the plan. Each syncs `state:draft` — **unpickable** — until a human approves it, instead of entering the queue as ordinary ready work.",
    listed.join("\n"),
    approvalHowTo("and push to this PR"),
  ].join("\n\n");
}

export function issueAuditComment(flag, { approved = false, approval = "" } = {}) {
  const verdict = approved
    ? `**Retroactive plan approved.** \`plan/${flag.slug}.md\` carries \`${APPROVAL_KEY}: ${oneLine(approval, 120)}\`, so this issue synced as ordinary ready work even though matching work already exists.`
    : `**Retroactive plan flagged.** Work matching \`plan/${flag.slug}.md\` already exists, so this issue synced \`state:draft\` — no agent will pick it up until a human approves it.`;
  const matched = ["Matched:", ...flag.matches.map((m) => `- ${describeMatch(m)}`)].join("\n");
  const parts = [auditMarker(flag.slug, approved ? "approved" : "flagged"), verdict, matched];
  if (!approved) parts.push(approvalHowTo("in a planning PR and merge it — the next sync flips this issue to ready and records the approval here"));
  return parts.join("\n\n");
}

// --- planning-PR check ---------------------------------------------------

const isAddedPlan = (f) => f.status === "added" && /^plan\/[^/]+\.md$/.test(f.filename || "") && !/\/README\.md$/.test(f.filename);

// The check needs only the title: no dependency on plan-sync's compiler.
export function frontmatterTitle(text = "") {
  const fm = String(text).match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
  const raw = fm.match(/^title:\s*(.*)$/m)?.[1] || "";
  return raw.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
}

// Compare every plan file this PR ADDS against live branches and open PRs;
// `readPlan` is injected so tests never touch the filesystem.
export async function runCheck({ gh, repo, prNumber, readPlan }) {
  const files = await paginate(gh, `/repos/${repo}/pulls/${prNumber}/files`, { cap: 300 });
  const added = files.filter(isAddedPlan).map((f) => f.filename);
  if (!added.length) return { added, flags: [], comment: null };
  const pr = await gh("GET", `/repos/${repo}/pulls/${prNumber}`);
  const refs = buildRefs({
    branches: await paginate(gh, `/repos/${repo}/branches`, { cap: 300 }),
    pulls: await paginate(gh, `/repos/${repo}/pulls?state=open`, { cap: 100 }),
    excludeBranch: pr?.head?.ref || "",
    excludePr: pr?.number || prNumber,
  });
  const flags = [];
  for (const file of added) {
    const slug = file.replace(/^plan\//, "").replace(/\.md$/, "");
    const matches = matchPlan({ slug, title: frontmatterTitle(await readPlan(file)) }, refs);
    if (matches.length) flags.push({ file, slug, matches });
  }
  return { added, flags, comment: formatCheckComment(flags) };
}

// One comment per PR, updated in place. `createIfMissing: false` keeps a clean
// planning PR quiet, while still updating an earlier flag comment to "clear".
export async function upsertComment(gh, repo, prNumber, body, { createIfMissing = true } = {}) {
  const comments = await paginate(gh, `/repos/${repo}/issues/${prNumber}/comments`, { cap: 200 });
  const existing = comments.find((c) => (c.body || "").includes(COMMENT_MARKER));
  if (existing) return gh("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
  return createIfMissing ? gh("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body }) : null;
}

async function main() {
  const prNumber = Number(process.env.PR_NUMBER || 0);
  if (!prNumber) { console.error("PR_NUMBER is required — this check runs on a pull_request event."); process.exit(2); }
  const { token, repo } = resolveAuth();
  const gh = ghClient(token);
  const { added, flags, comment } = await runCheck({ gh, repo, prNumber, readPlan: (f) => readFile(f, "utf8") });
  if (!added.length) return console.log("This PR adds no plan file — nothing for the retroactive check to compare.");
  console.log(comment.replace(COMMENT_MARKER, "").trim());
  try {
    await upsertComment(gh, repo, prNumber, comment, { createIfMissing: flags.length > 0 });
  } catch (e) {
    // A missing write grant (fork PR) must not hide the finding: the report is
    // already on stdout, so warn rather than fail red.
    console.log(`::warning::Could not post the retroactive-plan comment on PR #${prNumber} (${e.message}) — the report above still stands.`);
  }
}

// CLI — run only when invoked directly (robust to spaces in the path).
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    await main();
  } catch (e) {
    console.error(`Retroactive-plan check could not run: ${e.message}`);
    process.exit(1);
  }
}

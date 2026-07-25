#!/usr/bin/env node
// plan-sync.mjs — compile plan/*.md into GitHub issues, idempotently.
// Zero dependencies. Requires Node 20+ (global fetch). Token resolution order:
//   GITHUB_TOKEN env  ->  GITHUB_PAT (from .env or env)
//   GITHUB_REPOSITORY - "owner/repo" (set automatically in Actions)
// Run:  node scripts/plan-sync.mjs
//
// Design: the file is the source of truth for issue CONTENT. The marker
// `<!-- plan-id: <slug> -->` in each issue body is the only memory used for
// idempotency. Issues past `state:ready`/`state:draft` are never clobbered.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hasAcceptanceCriteria, planSlug, formatPlanMarker } from "./criteria.mjs";
import { ghClient, paginate, resolveAuth } from "./gh-api.mjs";
import { APPROVAL_KEY, auditMarker, buildRefs, issueAuditComment, matchPlan } from "./retroactive-plans.mjs";

// Token/repo (from GITHUB_TOKEN | GITHUB_PAT and GITHUB_REPOSITORY, environment
// or .env) and the shared REST client. Resolved at load so a missing credential
// fails before any plan file is touched, exactly as before.
const { token, repo: REPO } = resolveAuth();
const gh = ghClient(token);
const PLAN_DIR = process.env.PLAN_DIR || "plan";
const EDITABLE_STATES = new Set(["state:ready", "state:draft"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
// `risk` is the plan-time review tier, a closed set. Absent means normal, so
// only `high` earns a label — the tier travels issue -> PR from there.
const VALID_RISKS = new Set(["high", "normal"]);
const RISK_HIGH = "risk:high";
// The documented frontmatter surface (see plan/README.md). Anything else is a
// typo or an unsupported field: warned about, never silently honoured.
const KNOWN_KEYS = new Set(["title", "priority", "labels", "blocked_by", "estimated_lines", "locks", "risk", APPROVAL_KEY]);
// Priority order used wherever plans must be sorted deterministically.
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
// The plan-time size budget. The PR size gate measures the same number after the
// code exists, which only ever produces negotiation and overrides; refusing an
// over-cap estimate here forces the split while splitting is still free.
const MAX_ESTIMATED_LINES = 400;

// --- minimal frontmatter parser for the documented format only ---
function parsePlan(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const val = raw.replace(/\s+#.*$/, "").trim(); // strip inline comments (YAML: whitespace before #)
    if (val.startsWith("[")) {
      fm[key] = val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  const body = m[2].trim();
  const hasCriteria = hasAcceptanceCriteria(body);
  return { fm, body, hasCriteria };
}

async function listAllIssues() {
  const all = await paginate(gh, `/repos/${REPO}/issues?state=all`);
  return all.filter((i) => !i.pull_request);
}

const markerOf = formatPlanMarker;
function stateLabels(issue) {
  return issue.labels.map((l) => (typeof l === "string" ? l : l.name));
}

function blockerNumbers(issue) {
  const nums = [];
  const body = issue.body || "";
  for (const match of body.matchAll(/(?:^|\n)Blocked by #(\d+)\b/g)) {
    nums.push(Number(match[1]));
  }
  return nums;
}

function issueState(issue) {
  return (issue.state || "").toLowerCase();
}

function usableLabels(file, labels = []) {
  const kept = [];
  for (const label of labels) {
    const normalized = label.toLowerCase();
    if (normalized.startsWith("state:") || normalized.startsWith("priority:")) {
      console.log(`WARNING: ${file} has reserved label '${label}' — ignored`);
    } else {
      kept.push(label);
    }
  }
  return kept;
}

// `estimated_lines` is the author's estimate of hand-written changed lines for
// the plan (generated files excluded). Returns a human-readable reason string
// when the declared value is unusable or over the cap, or null when it is fine.
// Anything that is not a plain non-negative integer is rejected rather than
// coerced: a budget that silently reads as NaN or 0 is worse than no budget.
function sizeBudgetReason(raw) {
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    return `invalid estimated_lines '${value}' — must be a non-negative whole number`;
  }
  const lines = Number(value);
  if (lines > MAX_ESTIMATED_LINES) {
    return `estimated_lines ${lines} is over the ${MAX_ESTIMATED_LINES}-line cap`;
  }
  return null;
}

// `locks` names the exclusive resources a plan will take (`migration`,
// `route:/home`, `file:src/db/schema.ts`). Only a list is meaningful: a bare
// scalar would silently lock the one token it happens to spell, or nothing at
// all, so it is rejected rather than coerced.
function locksReason(raw) {
  if (Array.isArray(raw)) return null;
  const value = String(raw).trim();
  return `invalid locks '${value}' — must be a list of strings, e.g. locks: [migration, route:/home]`;
}

// Dependency edges as the sync sees them: slug -> the slugs it waits on.
// Current plan files are authoritative for their outgoing edges; marker-only
// issues contribute their rendered `Blocked by #N` lines so an edge assembled
// across syncs is still visible. Shared by the cycle gate and the lock resolver
// so both reason over exactly the same graph.
function dependencyAdjacency(plans, bySlug = new Map()) {
  const numberToSlug = new Map();
  for (const [slug, issue] of bySlug) numberToSlug.set(issue.number, slug);

  const adj = new Map();
  for (const [slug, { fm }] of plans) {
    adj.set(slug, (fm.blocked_by || []).filter((s) => plans.has(s) || bySlug.has(s)));
  }
  for (const [slug, issue] of bySlug) {
    if (plans.has(slug) || issueState(issue) === "closed") continue;
    const edges = blockerNumbers(issue)
      .map((n) => numberToSlug.get(n))
      .filter((s) => s && (plans.has(s) || bySlug.has(s)));
    if (edges.length) adj.set(slug, edges);
  }
  return adj;
}

// Does `from` already wait — directly or transitively — on `to`?
function dependsOn(adj, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const v = stack.pop();
    for (const w of adj.get(v) || []) {
      if (w === to) return true;
      if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
  }
  return false;
}

// Serialize plans that claim the same exclusive resource. Two plans holding the
// same lock token must never be pickable at once, so the later one waits on the
// earlier one through the ordinary `Blocked by #N` machinery — the same edge
// `unblock-dependents` clears when the holder closes, with no manual edit.
// Order within a token is deterministic (priority, then slug), and claimants
// are chained rather than all hung off the winner, so closing the head releases
// exactly one successor instead of the whole contending set. Tokens compare as
// exact strings: a lock is a name two authors agreed on, and guessing that
// `route:/Home` means `route:/home` would silently block unrelated work.
// Returns slug -> [{ token, holder, number }] for every plan that must wait.
function resolveLockConflicts(plans, bySlug, slugToNumber, adj) {
  const claimants = new Map();  // token -> [slug], insertion order irrelevant
  for (const [slug, { fm }] of plans) {
    const issue = bySlug.get(slug);
    // A closed issue's plan is finished work: it holds nothing.
    if (!issue || issueState(issue) === "closed") continue;
    for (const token of new Set(fm.locks || [])) {
      if (!claimants.has(token)) claimants.set(token, []);
      claimants.get(token).push(slug);
    }
  }

  const waiting = new Map();
  const byRankThenSlug = (a, b) =>
    PRIORITY_RANK[plans.get(a).fm.priority] - PRIORITY_RANK[plans.get(b).fm.priority] ||
    (a < b ? -1 : a > b ? 1 : 0);

  for (const token of [...claimants.keys()].sort()) {
    const contenders = claimants.get(token);
    if (contenders.length < 2) continue;
    const ordered = [...contenders].sort(byRankThenSlug);
    // Every conflicting pair is logged, not just the chained ones: the author
    // needs to see the whole contending set to judge whether the lock is right.
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        console.log(`LOCK CONFLICT '${token}': ${ordered[i]} and ${ordered[j]} both claim it`);
      }
    }
    for (let i = 1; i < ordered.length; i++) {
      const holder = ordered[i - 1];
      const waiter = ordered[i];
      // An existing dependency path already serializes the pair. Adding the
      // lock edge anyway would close a cycle — a deadlock the sync would then
      // refuse to run at all — so the existing edge is left to do the work.
      if (dependsOn(adj, holder, waiter) || dependsOn(adj, waiter, holder)) {
        console.log(`LOCK '${token}': ${waiter} and ${holder} are already serialized by blocked_by — no lock edge added`);
        continue;
      }
      adj.set(waiter, [...(adj.get(waiter) || []), holder]);
      if (!waiting.has(waiter)) waiting.set(waiter, []);
      waiting.get(waiter).push({ token, holder, number: slugToNumber.get(holder) });
      console.log(`LOCK '${token}': ${waiter} serialized behind ${holder} (#${slugToNumber.get(holder)})`);
    }
  }
  return waiting;
}

// Detect blocked_by cycles across live plan files and marker-resolved issues.
// Current plan files are authoritative for their outgoing edges; marker-only
// issues use their rendered `Blocked by #N` lines so a cycle assembled across
// syncs is still caught. Returns one ordered slug path per distinct cycle
// (deduped by membership); a plan blocked on itself yields a single-slug cycle.
// DFS with a recursion stack: a back edge to a slug still on the stack closes a
// cycle.
function findCycles(plans, bySlug = new Map()) {
  const adj = dependencyAdjacency(plans, bySlug);
  const cycles = [];
  const seen = new Set();   // membership keys already reported
  const color = new Map();  // slug -> 1 (on stack) | 2 (done); absent = unseen
  const path = [];
  const dfs = (v) => {
    color.set(v, 1);
    path.push(v);
    for (const w of adj.get(v) || []) {
      if (color.get(w) === 1) {
        const cyc = path.slice(path.indexOf(w));
        const key = [...cyc].sort().join(",");
        if (!seen.has(key)) { seen.add(key); cycles.push(cyc); }
      } else if (!color.has(w)) {
        dfs(w);
      }
    }
    path.pop();
    color.set(v, 2);
  };
  for (const v of adj.keys()) if (!color.has(v)) dfs(v);
  return cycles;
}

async function main() {
  // Top-level *.md only. Subdirectories are deliberately never scanned — notably
  // plan/done/, where the archive sweep (scripts/archive-closed-plans.mjs) parks
  // the plan files of closed issues. Those issues still carry their plan-id
  // marker, so a blocked_by pointing at an archived slug keeps resolving through
  // the marker (see the regression test) even though the file is out of scope.
  const entries = await readdir(PLAN_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
    .map((e) => e.name);

  // Pass 1: parse plan files (no network yet). Done first so the blocked_by
  // cycle gate below can fail before we touch GitHub — a deadlocked plan set
  // must leave every issue untouched.
  const plans = new Map();
  const invalidPlans = [];
  const oversizePlans = [];
  const badLockPlans = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const parsed = parsePlan(await readFile(join(PLAN_DIR, file), "utf8"));
    if (!parsed || !parsed.fm.title || !parsed.fm.priority) {
      invalidPlans.push(`${file} (missing title or priority)`);
      continue;
    }
    // A bad priority sorts as lowest and silently corrupts triage order, so it
    // is a hard skip, not a warning-and-continue — the file must be fixed.
    if (!VALID_PRIORITIES.has(parsed.fm.priority)) {
      invalidPlans.push(`${file} (invalid priority '${parsed.fm.priority}', must be high, medium, or low)`);
      continue;
    }
    // A risk value outside the closed set is a hard skip for the same reason: an
    // unreadable tier would sync as normal and route a schema/auth/secrets change
    // into the cheap review lane. Absent is fine — that *is* normal.
    if (parsed.fm.risk !== undefined && !VALID_RISKS.has(parsed.fm.risk)) {
      invalidPlans.push(`${file} (invalid risk '${parsed.fm.risk}', must be high or normal)`);
      continue;
    }
    // The size budget is a hard gate for the same reason the PR size cap is:
    // an over-cap plan has to become several plans, and that decision is only
    // cheap before any code exists. Absence is grandfathered with a warning.
    if (parsed.fm.estimated_lines === undefined) {
      console.log(`WARNING: ${file} is missing 'estimated_lines' (the plan-time size budget) — grandfathered, but new plans must declare it`);
    } else {
      const reason = sizeBudgetReason(parsed.fm.estimated_lines);
      if (reason) {
        oversizePlans.push(`${file} (${reason})`);
        continue;
      }
    }
    // A lock the compiler cannot read is worse than no lock: the plan would
    // sync as ready and collide with the work it meant to exclude.
    if (parsed.fm.locks !== undefined) {
      const reason = locksReason(parsed.fm.locks);
      if (reason) {
        badLockPlans.push(`${file} (${reason})`);
        continue;
      }
    }
    // Unknown keys and a missing blocked_by are warnings, not skips: the file
    // is still compiled. Warn once per unknown key, naming file and key.
    for (const key of Object.keys(parsed.fm)) {
      if (!KNOWN_KEYS.has(key)) {
        console.log(`WARNING: ${file} has unknown frontmatter key '${key}' — ignored, sync continues`);
      }
    }
    // Absent (undefined) is distinct from an empty list: the field is
    // documented as required, so its absence is worth flagging even though we
    // proceed as if it were [].
    if (parsed.fm.blocked_by === undefined) {
      console.log(`WARNING: ${file} is missing 'blocked_by' (documented as required) — treating as no blockers`);
    }
    plans.set(slug, parsed);
  }

  if (invalidPlans.length) {
    console.error("ERROR: invalid plan frontmatter skipped one or more files. Nothing was changed.");
    console.error("Fix these plan files, then re-sync:");
    for (const reason of invalidPlans) console.error(`  • ${reason}`);
    process.exit(1);
  }

  // Size-budget gate — before any network call, so nothing on GitHub changes.
  if (oversizePlans.length) {
    console.error(`ERROR: plan size budget rejected one or more files. Nothing was changed.`);
    console.error(`A plan may estimate at most ${MAX_ESTIMATED_LINES} hand-written changed lines`);
    console.error(`(generated files excluded). Split the plan into smaller plan files — one`);
    console.error(`issue each — before writing any code, then re-sync:`);
    for (const reason of oversizePlans) console.error(`  • ${reason}`);
    process.exit(1);
  }

  // Lock gate — same shape as the size gate, and for the same reason: it runs
  // before any network call, so an unreadable lock changes nothing on GitHub.
  if (badLockPlans.length) {
    console.error("ERROR: unreadable 'locks' frontmatter in one or more files. Nothing was changed.");
    console.error("Declare locks as a list of exact tokens — for example");
    console.error("`locks: [migration, route:/home, file:src/db/schema.ts]` — then re-sync:");
    for (const reason of badLockPlans) console.error(`  • ${reason}`);
    process.exit(1);
  }

  // Fail fast for cycles fully described by the current batch before any
  // network call. Marker-resolved cross-sync cycles are checked after issue
  // discovery below, still before any mutation.
  const fileCycles = findCycles(plans);
  if (fileCycles.length) {
    console.error("ERROR: blocked_by cycle detected — this is a deadlock.");
    console.error("No issue in a cycle can ever be unblocked. Nothing was changed. Break each");
    console.error("cycle by removing a blocked_by edge, then re-sync:");
    for (const cyc of fileCycles) console.error(`  • ${cyc.join(" → ")} → ${cyc[0]}`);
    process.exit(1);
  }

  // Now read existing issues (network). Seed slug -> number from every
  // marker-bearing issue (not just those with a live plan file) so blockers on
  // removed or skipped plans still resolve.
  const issues = await listAllIssues();
  const bySlug = new Map();
  const slugToIssueNums = new Map();  // slug -> every issue number carrying it
  for (const issue of issues) {
    const slug = planSlug(issue.body || "");
    if (!slug) continue;
    bySlug.set(slug, issue);
    if (!slugToIssueNums.has(slug)) slugToIssueNums.set(slug, []);
    slugToIssueNums.get(slug).push(issue.number);
  }
  // A slug carried by more than one issue is a duplicate the compiler must not
  // extend: bySlug.has(slug) already suppresses re-creation in pass 2a, so warn
  // loudly (naming every duplicate) rather than silently creating an Nth issue
  // or clobbering one at random. Closing the surplus is a human action.
  for (const [slug, nums] of slugToIssueNums) {
    if (nums.length > 1) {
      const named = nums.map((n) => `#${n}`).join(", ");
      console.log(`WARNING: slug '${slug}' resolves to ${nums.length} issues (${named}); no new issue will be created for it — close the duplicate(s) so exactly one remains.`);
    }
  }
  const slugToNumber = new Map();
  for (const [slug, issue] of bySlug) slugToNumber.set(slug, issue.number);

  // Cycle gate: a blocked_by cycle is a deadlock — no issue in the cycle can
  // ever be unblocked and unblock-dependents would never fire. Fail loudly,
  // naming every slug in each cycle, before creating or editing anything on
  // GitHub.
  const cycles = findCycles(plans, bySlug);
  if (cycles.length) {
    console.error("ERROR: blocked_by cycle detected — this is a deadlock.");
    console.error("No issue in a cycle can ever be unblocked. Nothing was changed. Break each");
    console.error("cycle by removing a blocked_by edge, then re-sync:");
    for (const cyc of cycles) console.error(`  • ${cyc.join(" → ")} → ${cyc[0]}`);
    process.exit(1);
  }

  // Pass 2a: create a minimal issue for every new plan BEFORE rendering any
  // body, so slugToNumber is total and a blocker can never be dropped just
  // because its file sorts later in the directory. The marker goes in now:
  // a crash before pass 2b must leave an issue the next run finds and
  // repairs, not a duplicate. state:draft is deliberate — never expose a
  // pickable state until blockers are resolved in pass 2b.
  for (const [slug, { fm }] of plans) {
    if (bySlug.has(slug)) continue;
    const created = await gh("POST", `/repos/${REPO}/issues`, {
      title: fm.title,
      body: markerOf(slug),
      labels: ["state:draft", `priority:${fm.priority}`],
    });
    bySlug.set(slug, created);
    slugToNumber.set(slug, created.number);
    console.log(`CREATE #${created.number} ${slug}`);
  }

  // Retroactive-plan detection (#471): live branches and open PRs, so a plan
  // whose work already exists cannot enter the queue as ready work. It degrades
  // on purpose — a failed listing warns loudly and the sync continues.
  let retroRefs = null;
  try {
    retroRefs = buildRefs({
      branches: await paginate(gh, `/repos/${REPO}/branches`, { cap: 300 }),
      pulls: await paginate(gh, `/repos/${REPO}/pulls?state=open`, { cap: 100 }),
    });
  } catch (e) {
    console.log(`WARNING: retroactive-plan check skipped — could not list branches/PRs (${e.message}); plans synced without it`);
  }

  // One audit comment per issue per outcome; the marker keeps re-syncs quiet.
  const postAuditOnce = async (number, flag, opts) => {
    const marker = auditMarker(flag.slug, opts.approved ? "approved" : "flagged");
    const seen = await paginate(gh, `/repos/${REPO}/issues/${number}/comments`, { cap: 200 });
    if (!seen.some((c) => (c.body || "").includes(marker))) await gh("POST", `/repos/${REPO}/issues/${number}/comments`, { body: issueAuditComment(flag, opts) });
  };

  // Exclusive resources: decided after pass 2a (so every holder already has an
  // issue number) and before any body is rendered, so a serialized plan is
  // written out blocked on its first sync rather than a run later.
  const lockWaits = resolveLockConflicts(plans, bySlug, slugToNumber, dependencyAdjacency(plans, bySlug));

  // Pass 2b: build bodies (with resolved Blocked by #N), then patch.
  const drafted = [];   // slugs that landed as state:draft (no acceptance criteria)
  const flagged = [];   // slugs held at state:draft because their work already exists
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  for (const [slug, { fm, body, hasCriteria }] of plans) {
    for (const s of (fm.blocked_by || []).filter((s) => !slugToNumber.has(s))) {
      console.log(`WARNING: unresolved blocker '${s}' in ${slug} — no plan file or issue has that slug; link dropped`);
    }
    const blockerNums = (fm.blocked_by || []).map((s) => slugToNumber.get(s)).filter(Boolean);
    // A contested lock renders as an ordinary `Blocked by #N` line — that is
    // what makes `unblock-dependents` release it when the holder closes — with
    // the reason and the conflicting slug spelled out for the human reading it.
    const lockWaitsHere = (lockWaits.get(slug) || []).filter((w) => w.number && !blockerNums.includes(w.number));
    const blockLines = [
      ...blockerNums.map((n) => `Blocked by #${n}`),
      ...lockWaitsHere.map((w) => `Blocked by #${w.number} (lock \`${w.token}\` is also claimed by ${w.holder})`),
    ];
    const blockedText = blockLines.length ? `\n\n${blockLines.join("\n")}` : "";
    const fullBody = `${body}${blockedText}\n\n${markerOf(slug)}`;
    // Blocked means blocked *now*: a closed blocker no longer blocks. Deriving
    // state from the plan file alone would re-block issues unblock-dependents
    // already flipped to ready. (A blocker missing from byNumber was created
    // in pass 2a, so it is open by definition.)
    const openBlockers = [...blockerNums, ...lockWaitsHere.map((w) => w.number)]
      .filter((n) => byNumber.get(n)?.state !== "closed");
    // A plan whose work already exists is not ready work, however complete its
    // criteria: held at draft until a human writes the approval into the plan
    // file. An approved plan syncs exactly as it always did.
    const approval = fm[APPROVAL_KEY];
    const matches = retroRefs ? matchPlan({ slug, title: fm.title }, retroRefs) : [];
    const isRetro = matches.length > 0 && !approval;
    const ready = hasCriteria && !isRetro;
    const state = openBlockers.length ? "state:blocked" : (ready ? "state:ready" : "state:draft");
    // The risk tier rides on the issue as a label so every downstream consumer
    // (review tiering, the PR handoff) reads one place instead of re-deriving it.
    const riskLabels = fm.risk === "high" ? [RISK_HIGH] : [];
    const labels = [state, `priority:${fm.priority}`, ...riskLabels, ...usableLabels(`${slug}.md`, fm.labels || [])];
    if (state === "state:draft" && hasCriteria === false) drafted.push(slug);
    if (isRetro) flagged.push(slug);

    const existing = bySlug.get(slug);
    const current = stateLabels(existing).filter((l) => l.startsWith("state:"))[0];
    if (!EDITABLE_STATES.has(current) && current !== "state:blocked") {
      console.log(`HOLD  #${existing.number} ${slug} (live: ${current})`);
      continue;
    }
    await gh("PATCH", `/repos/${REPO}/issues/${existing.number}`, { title: fm.title, body: fullBody, labels });
    console.log(`UPDATE #${existing.number} [${state}] ${slug}`);
    // Audit trail on the issue: why it is unpickable, or who let it through.
    try {
      if (matches.length) await postAuditOnce(existing.number, { slug, matches }, { approved: Boolean(approval), approval: approval || "" });
    } catch (e) {
      console.log(`WARNING: could not record the retroactive-plan note on #${existing.number} (${e.message})`);
    }
  }

  // Loud summary: drafts are unpickable and freeze anything that depends on them.
  if (drafted.length) {
    console.log("");
    console.log(`WARNING: ${drafted.length} file(s) have NO acceptance criteria and were`);
    console.log(`labelled state:draft — they will NOT be picked, and any issue blocked on`);
    console.log(`them stays frozen. Add a "## Acceptance criteria" block with at least one`);
    console.log(`- [ ] item to each, then re-sync:`);
    for (const s of drafted) console.log(`  • ${s}`);
  }

  // Loud summary: a flagged plan is unpickable for a different reason — the fix
  // is a human decision, not a missing criterion.
  if (flagged.length) {
    console.log("");
    console.log(`WARNING: ${flagged.length} plan(s) match work that already exists on a branch or PR and`);
    console.log(`were labelled state:draft — they will NOT be picked. Each issue carries a comment`);
    console.log(`naming what it matched; approve one by adding "${APPROVAL_KEY}: <why>" to its plan file`);
    console.log(`in a planning PR, then re-sync:`);
    for (const s of flagged) console.log(`  • ${s}`);
  }
}

// Top-level await (not .catch()) so a test that dynamically imports this
// module resumes only after the sync has fully finished. `main` is also
// exported so an idempotency test can drive a second sync run against the same
// in-memory issue store within one process (the module body runs only once).
export { main };
try {
  await main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

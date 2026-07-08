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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasAcceptanceCriteria } from "./criteria.mjs";

// Local convenience: load .env if present (Actions sets env vars directly).
// Never overrides an already-set variable. .env must be gitignored.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const REPO = process.env.GITHUB_REPOSITORY;
const PLAN_DIR = process.env.PLAN_DIR || "plan";
const API = "https://api.github.com";
const EDITABLE_STATES = new Set(["state:ready", "state:draft"]);
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
// The documented frontmatter surface (see plan/README.md). Anything else is a
// typo or an unsupported field: warned about, never silently honoured.
const KNOWN_KEYS = new Set(["title", "priority", "labels", "blocked_by"]);

if (!TOKEN || !REPO) {
  console.error("Missing token or repo. Set GITHUB_PAT in .env (local) or GITHUB_TOKEN/GITHUB_REPOSITORY in the environment.");
  process.exit(1);
}

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

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
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh("GET", `/repos/${REPO}/issues?state=all&per_page=100&page=${page}`);
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  return out;
}

function markerOf(slug) {
  return `<!-- plan-id: ${slug} -->`;
}
function stateLabels(issue) {
  return issue.labels.map((l) => (typeof l === "string" ? l : l.name));
}

// Detect blocked_by cycles among plan files. Only edges whose target is also a
// plan file in this sync can form a cycle (issues carry no outgoing blocked_by),
// so the graph is built from `plans` alone. Returns one ordered slug path per
// distinct cycle (deduped by membership); a plan blocked on itself yields a
// single-slug cycle. DFS with a recursion stack: a back edge to a slug still on
// the stack closes a cycle.
function findCycles(plans) {
  const adj = new Map();
  for (const [slug, { fm }] of plans) {
    adj.set(slug, (fm.blocked_by || []).filter((s) => plans.has(s)));
  }
  const cycles = [];
  const seen = new Set();   // membership keys already reported
  const color = new Map();  // slug -> 1 (on stack) | 2 (done); absent = unseen
  const path = [];
  const dfs = (v) => {
    color.set(v, 1);
    path.push(v);
    for (const w of adj.get(v)) {
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
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const parsed = parsePlan(await readFile(join(PLAN_DIR, file), "utf8"));
    if (!parsed || !parsed.fm.title || !parsed.fm.priority) {
      console.log(`SKIP ${file} (missing title or priority)`);
      continue;
    }
    // A bad priority sorts as lowest and silently corrupts triage order, so it
    // is a hard skip, not a warning-and-continue — the file must be fixed.
    if (!VALID_PRIORITIES.has(parsed.fm.priority)) {
      console.log(`SKIP ${file} — WARNING: invalid priority '${parsed.fm.priority}' (must be high, medium, or low)`);
      continue;
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

  // Cycle gate: a blocked_by cycle among plan files is a deadlock — no issue in
  // the cycle can ever be unblocked and unblock-dependents would never fire.
  // Fail loudly, naming every slug in each cycle, before creating or editing
  // anything on GitHub.
  const cycles = findCycles(plans);
  if (cycles.length) {
    console.error("ERROR: blocked_by cycle detected among plan files — this is a deadlock.");
    console.error("No issue in a cycle can ever be unblocked. Nothing was changed. Break each");
    console.error("cycle by removing a blocked_by edge, then re-sync:");
    for (const cyc of cycles) console.error(`  • ${cyc.join(" → ")} → ${cyc[0]}`);
    process.exit(1);
  }

  // Now read existing issues (network). Seed slug -> number from every
  // marker-bearing issue (not just those with a live plan file) so blockers on
  // removed or skipped plans still resolve.
  const issues = await listAllIssues();
  const bySlug = new Map();
  for (const issue of issues) {
    const mm = (issue.body || "").match(/<!-- plan-id: (.+?) -->/);
    if (mm) bySlug.set(mm[1], issue);
  }
  const slugToNumber = new Map();
  for (const [slug, issue] of bySlug) slugToNumber.set(slug, issue.number);

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

  // Pass 2b: build bodies (with resolved Blocked by #N), then patch.
  const drafted = [];   // slugs that landed as state:draft (no acceptance criteria)
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  for (const [slug, { fm, body, hasCriteria }] of plans) {
    for (const s of (fm.blocked_by || []).filter((s) => !slugToNumber.has(s))) {
      console.log(`WARNING: unresolved blocker '${s}' in ${slug} — no plan file or issue has that slug; link dropped`);
    }
    const blockerNums = (fm.blocked_by || []).map((s) => slugToNumber.get(s)).filter(Boolean);
    const blockedText = blockerNums.length ? `\n\n${blockerNums.map((n) => `Blocked by #${n}`).join("\n")}` : "";
    const fullBody = `${body}${blockedText}\n\n${markerOf(slug)}`;
    // Blocked means blocked *now*: a closed blocker no longer blocks. Deriving
    // state from the plan file alone would re-block issues unblock-dependents
    // already flipped to ready. (A blocker missing from byNumber was created
    // in pass 2a, so it is open by definition.)
    const openBlockers = blockerNums.filter((n) => byNumber.get(n)?.state !== "closed");
    const state = openBlockers.length ? "state:blocked" : (hasCriteria ? "state:ready" : "state:draft");
    const labels = [state, `priority:${fm.priority}`, ...(fm.labels || [])];
    if (state === "state:draft") drafted.push(slug);

    const existing = bySlug.get(slug);
    const current = stateLabels(existing).filter((l) => l.startsWith("state:"))[0];
    if (!EDITABLE_STATES.has(current) && current !== "state:blocked") {
      console.log(`HOLD  #${existing.number} ${slug} (live: ${current})`);
      continue;
    }
    await gh("PATCH", `/repos/${REPO}/issues/${existing.number}`, { title: fm.title, body: fullBody, labels });
    console.log(`UPDATE #${existing.number} [${state}] ${slug}`);
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
}

// Top-level await (not .catch()) so a test that dynamically imports this
// module resumes only after the sync has fully finished.
try {
  await main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

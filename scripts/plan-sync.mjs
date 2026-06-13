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
  const hasCriteria = /##\s*Acceptance criteria/i.test(body) && /-\s*\[[ x]\]/i.test(body);
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

async function main() {
  const files = (await readdir(PLAN_DIR)).filter((f) => f.endsWith(".md") && f !== "README.md");
  const issues = await listAllIssues();
  const bySlug = new Map();
  for (const issue of issues) {
    const mm = (issue.body || "").match(/<!-- plan-id: (.+?) -->/);
    if (mm) bySlug.set(mm[1], issue);
  }

  // Pass 1: create or update each plan file's issue, record slug -> number.
  const slugToNumber = new Map();
  const plans = new Map();
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const parsed = parsePlan(await readFile(join(PLAN_DIR, file), "utf8"));
    if (!parsed || !parsed.fm.title || !parsed.fm.priority) {
      console.log(`SKIP ${file} (missing title or priority)`);
      continue;
    }
    plans.set(slug, parsed);
    const existing = bySlug.get(slug);
    if (existing) slugToNumber.set(slug, existing.number);
  }

  // Pass 2: build bodies (with resolved Blocked by #N), then upsert.
  for (const [slug, { fm, body, hasCriteria }] of plans) {
    const blockerNums = (fm.blocked_by || []).map((s) => slugToNumber.get(s)).filter(Boolean);
    const blockedText = blockerNums.length ? `\n\n${blockerNums.map((n) => `Blocked by #${n}`).join("\n")}` : "";
    const fullBody = `${body}${blockedText}\n\n${markerOf(slug)}`;
    const labels = [
      hasCriteria ? "state:ready" : "state:draft",
      `priority:${fm.priority}`,
      ...(fm.labels || []),
    ];
    if (blockerNums.length) labels[0] = "state:blocked";

    const existing = bySlug.get(slug);
    if (!existing) {
      const created = await gh("POST", `/repos/${REPO}/issues`, { title: fm.title, body: fullBody, labels });
      slugToNumber.set(slug, created.number);
      console.log(`CREATE #${created.number} ${slug}`);
    } else {
      const current = stateLabels(existing).filter((l) => l.startsWith("state:"))[0];
      if (!EDITABLE_STATES.has(current) && current !== "state:blocked") {
        console.log(`HOLD  #${existing.number} ${slug} (live: ${current})`);
        continue;
      }
      await gh("PATCH", `/repos/${REPO}/issues/${existing.number}`, { title: fm.title, body: fullBody, labels });
      console.log(`UPDATE #${existing.number} ${slug}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

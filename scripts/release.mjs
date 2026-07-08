#!/usr/bin/env node
// release.mjs — the opt-in release lane: tag a version and publish a changelog
// built from the PR titles merged since the last release. Zero dependencies.
// Requires Node 20+ (global fetch). Token resolution mirrors plan-sync.mjs:
//   GITHUB_TOKEN env  ->  GITHUB_PAT (from .env or env)
//   GITHUB_REPOSITORY - "owner/repo" (set automatically in Actions)
//   RELEASE_BUMP      - major | minor | patch   (default: patch)
// Run:  node scripts/release.mjs
//
// This is the post-merge "ship" stage. It is off by default at the workflow
// level (gated on the RATCHET_RELEASE repo variable) and only ever runs on
// demand, so no project pays for it unless it opts in.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Local convenience: load .env if present (Actions sets env vars directly).
// Never overrides an already-set variable. .env must be gitignored.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const API = "https://api.github.com";
const VALID_BUMPS = new Set(["major", "minor", "patch"]);

// One API call. `allow404` lets the caller treat "not found" as a normal,
// expected outcome (a repo with no releases yet) rather than a hard error.
async function gh(token, method, path, { body, allow404 = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Parse "v1.2.3" (or "1.2.3") into parts, remembering the "v" prefix so the
// next tag keeps the repo's existing style. Returns null for a non-semver tag.
function parseVersion(tag) {
  const m = String(tag).match(/^(v?)(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], major: +m[2], minor: +m[3], patch: +m[4] };
}

function bumpVersion(parts, bump) {
  let { major, minor, patch } = parts;
  if (bump === "major") { major += 1; minor = 0; patch = 0; }
  else if (bump === "minor") { minor += 1; patch = 0; }
  else { patch += 1; }
  return `${parts.prefix}${major}.${minor}.${patch}`;
}

// Every PR merged into the default branch after `since` (an ISO timestamp, or
// null to take all merged PRs — the first-ever release).
async function mergedPRsSince(token, repo, since) {
  const merged = [];
  for (let page = 1; ; page++) {
    const batch = await gh(token, "GET", `/repos/${repo}/pulls?state=closed&per_page=100&page=${page}`);
    for (const pr of batch) {
      if (pr.merged_at && (!since || pr.merged_at > since)) {
        merged.push({ number: pr.number, title: pr.title, merged_at: pr.merged_at });
      }
    }
    if (batch.length < 100) break;
  }
  return merged.sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));
}

export async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  const bump = (process.env.RELEASE_BUMP || "patch").toLowerCase();

  if (!token || !repo) {
    throw new Error(
      "Missing token or repo. Set GITHUB_PAT in .env (local) or GITHUB_TOKEN/GITHUB_REPOSITORY in the environment.",
    );
  }
  if (!VALID_BUMPS.has(bump)) {
    throw new Error(`Invalid RELEASE_BUMP '${bump}' — must be major, minor, or patch.`);
  }

  // The last release anchors both the version to bump and the "since" window.
  // No release yet is a normal first-run, not an error: start from v0.0.0 and
  // include every merged PR.
  const latest = await gh(token, "GET", `/repos/${repo}/releases/latest`, { allow404: true });
  const lastTag = latest?.tag_name || null;
  const since = latest ? (latest.published_at || latest.created_at) : null;

  const base = lastTag ? parseVersion(lastTag) : { prefix: "v", major: 0, minor: 0, patch: 0 };
  if (!base) {
    throw new Error(
      `Latest release tag '${lastTag}' is not semver (expected vMAJOR.MINOR.PATCH); cannot compute the next version. Tag a semver release manually, then re-run.`,
    );
  }

  const prs = await mergedPRsSince(token, repo, since);
  if (prs.length === 0) {
    console.log(`Nothing to release — no PRs merged since ${lastTag || "the start of the project"}.`);
    return { released: false };
  }

  const version = bumpVersion(base, bump);
  const today = new Date().toISOString().slice(0, 10);
  const lines = prs.map((pr) => `- ${pr.title} (#${pr.number})`);
  const changelog = [
    `## ${version} (${today})`,
    "",
    ...lines,
    "",
    `_${prs.length} merged PR(s) since ${lastTag || "the start of the project"}._`,
  ].join("\n");

  const release = await gh(token, "POST", `/repos/${repo}/releases`, {
    body: {
      tag_name: version,
      name: version,
      target_commitish: "main",
      body: changelog,
    },
  });

  console.log(`Released ${version} from ${prs.length} merged PR(s).`);
  console.log(changelog);
  if (release?.html_url) console.log(release.html_url);
  return { released: true, version, count: prs.length };
}

// Auto-run only when executed directly (`node scripts/release.mjs`), never when
// imported by the test, so the test can drive main() under several scenarios.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

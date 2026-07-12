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

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION_LOCATIONS } from "./version-consistency.mjs";

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

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  appendFileSync(f, `${name}=${String(value).replace(/\n/g, "%0A")}\n`);
}

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
  if (!res.ok) {
    const text = await res.text();
    // Attach the status and raw body so callers can discriminate one failure
    // mode from another (e.g. a tag-collision 422 vs. an invalid-input 422)
    // instead of pattern-matching a flattened message string.
    const err = new Error(`${method} ${path} -> ${res.status} ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function apiPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// True only when a 422 body reports the *tag* already exists — GitHub's
// validation error carries an `errors[]` entry of {field:"tag_name",
// code:"already_exists"}. Any other 422 (an invalid target_commitish, a
// malformed field) fails this check, so it is never mistaken for a benign
// tag collision. Fails closed on a body that is not the expected JSON shape.
function isTagAlreadyExists(body) {
  try {
    const parsed = JSON.parse(body);
    return (
      Array.isArray(parsed.errors) &&
      parsed.errors.some((e) => e.field === "tag_name" && e.code === "already_exists")
    );
  } catch {
    return false;
  }
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

function bareVersion(version) {
  const parts = parseVersion(version);
  if (!parts) throw new Error(`Internal error: computed invalid release version '${version}'.`);
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

export function updateVersionFile(file, text, version) {
  const bare = bareVersion(version);
  if (file === ".ratchet-version") return `${bare}\n`;
  if (file === "plugin/.claude-plugin/plugin.json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`Cannot update ${file}: invalid JSON (${e.message}).`);
    }
    parsed.version = bare;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if (file === "README.md") {
    if (!/framework-v?\d+\.\d+\.\d+/.test(text)) {
      throw new Error("Cannot update README.md: no framework-vX.Y.Z badge found.");
    }
    return text.replace(/framework-v?\d+\.\d+\.\d+/, `framework-v${bare}`);
  }
  if (file === "DOCS.md") {
    if (!/^Version\s+v?\d+\.\d+\.\d+/m.test(text)) {
      throw new Error("Cannot update DOCS.md: no Version X.Y.Z header found.");
    }
    return text.replace(/^Version\s+v?\d+\.\d+\.\d+/m, `Version ${bare}`);
  }
  if (file === "index.html") {
    // The static site pins the version in several places (hero eyebrow, install
    // and bootstrap commands). Guard first so a site missing every recognizable
    // occurrence aborts the whole bump — never a partial write — then rewrite
    // every `vMAJOR.MINOR.PATCH` at once so no stale copy is left behind.
    if (!/v\d+\.\d+\.\d+/.test(text)) {
      throw new Error(
        "Cannot update index.html: no vMAJOR.MINOR.PATCH version occurrence found.",
      );
    }
    return text.replace(/v\d+\.\d+\.\d+/g, `v${bare}`);
  }
  throw new Error(`Cannot update unknown version location ${file}.`);
}

// Numeric compare of two parsed versions. > 0 when `a` is newer than `b`.
function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

// The highest existing semver tag in the repo (across all pages), or null if
// there are none. Non-semver tags are ignored. Tags — not releases — are the
// source of truth for "which version numbers are taken": a tag left behind by a
// partial run, a manual tag, or a deleted release still counts, so we never
// recompute a version that already exists and hit an unhandled 422.
async function highestSemverTag(token, repo) {
  let best = null;
  for (let page = 1; ; page++) {
    const batch = await gh(token, "GET", `/repos/${repo}/tags?per_page=100&page=${page}`);
    for (const t of batch) {
      const parts = parseVersion(t.name);
      if (parts && (!best || compareVersions(parts, best) > 0)) best = parts;
    }
    if (batch.length < 100) break;
  }
  return best;
}

// Seed the first-ever release from `.ratchet-version` (the installed framework
// version) so it ships as advertised instead of a bare v0.0.1. Returns a tag
// string, or null when the file is absent or empty. A malformed file is a clear
// error, not a silent fallback — the first tag is not something to guess at.
function readSeedVersion() {
  if (!existsSync(".ratchet-version")) return null;
  const raw = readFileSync(".ratchet-version", "utf8").trim();
  if (!raw) return null;
  const parts = parseVersion(raw);
  if (!parts) {
    throw new Error(
      `.ratchet-version contains '${raw}', which is not semver (expected MAJOR.MINOR.PATCH, optionally v-prefixed). Fix or remove it, then re-run the first release.`,
    );
  }
  // Repo tag convention is a leading "v" (see DOCS.md); normalise so the first
  // tag matches and later bumps keep the same style.
  const prefix = parts.prefix || "v";
  return `${prefix}${parts.major}.${parts.minor}.${parts.patch}`;
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

async function readRepoFile(token, repo, file, ref) {
  const res = await gh(token, "GET", `/repos/${repo}/contents/${apiPath(file)}?ref=${encodeURIComponent(ref)}`);
  if (typeof res.content !== "string") {
    throw new Error(`Cannot read ${file}: GitHub API did not return file content.`);
  }
  return Buffer.from(res.content.replace(/\n/g, ""), "base64").toString("utf8");
}

async function createVersionBumpPr(token, repo, { version, defaultBranch, baseSha, changelog }) {
  const branchName = `release/${version}`;
  const title = `chore: release ${version}`;

  const baseCommit = await gh(token, "GET", `/repos/${repo}/git/commits/${baseSha}`);
  const baseTree = baseCommit?.tree?.sha;
  if (!baseTree) {
    throw new Error(`Cannot create release bump: default branch commit ${baseSha} has no tree SHA.`);
  }

  await gh(token, "POST", `/repos/${repo}/git/refs`, {
    body: {
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    },
  });

  const tree = [];
  for (const loc of VERSION_LOCATIONS) {
    const file = loc.file.split("\\").join("/");
    const current = await readRepoFile(token, repo, file, baseSha);
    tree.push({
      path: file,
      mode: "100644",
      type: "blob",
      content: updateVersionFile(file, current, version),
    });
  }

  const newTree = await gh(token, "POST", `/repos/${repo}/git/trees`, {
    body: {
      base_tree: baseTree,
      tree,
    },
  });
  const commit = await gh(token, "POST", `/repos/${repo}/git/commits`, {
    body: {
      message: `chore: release ${version}`,
      tree: newTree.sha,
      parents: [baseSha],
    },
  });

  await gh(token, "PATCH", `/repos/${repo}/git/refs/heads/${branchName}`, {
    body: {
      sha: commit.sha,
      force: false,
    },
  });

  const pr = await gh(token, "POST", `/repos/${repo}/pulls`, {
    body: {
      title,
      head: branchName,
      base: defaultBranch,
      body: [
        `Release bump for ${version}.`,
        "",
        "This release lane uses the publish-then-bump-PR path: the tag/release is published from this bumped commit immediately, while the version-file write-back reaches the default branch only after this reviewable PR is merged.",
        "",
        changelog,
      ].join("\n"),
    },
  });

  return { branchName, commitSha: commit.sha, pr };
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

  // The latest *release* anchors only the changelog window (which PRs are new).
  // Version numbering comes from tags below — releases can be deleted while their
  // tags remain, so the release is the wrong thing to number from. No release yet
  // is a normal first run, not an error: include every merged PR.
  const latest = await gh(token, "GET", `/repos/${repo}/releases/latest`, { allow404: true });
  const lastTag = latest?.tag_name || null;
  const since = latest ? (latest.published_at || latest.created_at) : null;

  const prs = await mergedPRsSince(token, repo, since);
  if (prs.length === 0) {
    console.log(`Nothing to release — no PRs merged since ${lastTag || "the start of the project"}.`);
    setOutput("released", "false");
    return { released: false };
  }

  // Next version from the highest existing semver tag, so a dangling tag from a
  // partial run advances the number instead of colliding with it. With no tags
  // at all it is the first-ever release: seed from .ratchet-version.
  const topTag = await highestSemverTag(token, repo);
  const version = topTag
    ? bumpVersion(topTag, bump)
    : readSeedVersion() || bumpVersion({ prefix: "v", major: 0, minor: 0, patch: 0 }, bump);

  // Guard against a collision the bump can't see — a concurrent run, or a tag
  // created since we listed tags. Never let the create call fail with a raw 422:
  // check first and exit cleanly, having created nothing.
  const clash = await gh(token, "GET", `/repos/${repo}/git/ref/tags/${version}`, { allow404: true });
  if (clash) {
    console.log(`Tag ${version} already exists — nothing released. Remove the tag or choose a different bump, then re-run.`);
    setOutput("released", "false");
    return { released: false, reason: "tag-exists" };
  }

  // Target the repository's default branch, not a hardcoded "main". A consumer
  // repo whose default is master/trunk/develop would otherwise get a release
  // POST with a target_commitish that names no real branch — which GitHub
  // rejects with a 422 indistinguishable from a tag collision. Read the real
  // default branch from the repo so the tag lands on it.
  const repoMeta = await gh(token, "GET", `/repos/${repo}`);
  const defaultBranch = repoMeta?.default_branch || "main";
  const defaultRef = await gh(token, "GET", `/repos/${repo}/git/ref/heads/${defaultBranch}`);
  const baseSha = defaultRef?.object?.sha;
  if (!baseSha) {
    throw new Error(`Cannot resolve default branch '${defaultBranch}' to a commit SHA.`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = prs.map((pr) => `- ${pr.title} (#${pr.number})`);
  const changelog = [
    `## ${version} (${today})`,
    "",
    ...lines,
    "",
    `_${prs.length} merged PR(s) since ${lastTag || "the start of the project"}._`,
  ].join("\n");

  const bumpPr = await createVersionBumpPr(token, repo, {
    version,
    defaultBranch,
    baseSha,
    changelog,
  });

  let release;
  try {
    release = await gh(token, "POST", `/repos/${repo}/releases`, {
      body: {
        tag_name: version,
        name: version,
        target_commitish: bumpPr.commitSha,
        body: changelog,
      },
    });
  } catch (e) {
    // Only a 422 whose body reports the *tag* already exists is a benign
    // no-op: the tag was created between our pre-flight check and now (a
    // concurrent run beat us), so nothing here is left half-done. Every other
    // 422 — an invalid target_commitish, any other validation failure — is a
    // real error and must surface loudly with the API's actual message, not be
    // silently swallowed as "another run beat us to it".
    if (e.status === 422 && isTagAlreadyExists(e.body)) {
      console.log(`Tag ${version} already exists — another run beat us to it; nothing released, nothing partial created.`);
      setOutput("released", "false");
      return { released: false, reason: "tag-exists" };
    }
    throw e;
  }

  console.log(`Released ${version} from ${prs.length} merged PR(s).`);
  if (bumpPr.pr?.html_url) console.log(`Version bump PR: ${bumpPr.pr.html_url}`);
  console.log(changelog);
  if (release?.html_url) console.log(release.html_url);
  setOutput("released", "true");
  setOutput("version", version);
  setOutput("release_url", release?.html_url || "");
  setOutput("bump_pr_url", bumpPr.pr?.html_url || "");
  return { released: true, version, count: prs.length, bump: bumpPr };
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

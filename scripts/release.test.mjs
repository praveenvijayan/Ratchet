#!/usr/bin/env node
// release.test.mjs — regression test for the opt-in release lane.
// Zero dependencies. Run:  node scripts/release.test.mjs
//
// Covers the acceptance criteria of the release lane:
//   1. tags the next version and builds a changelog from merged PR titles
//   2. safe default — the workflow job is gated on RATCHET_RELEASE
//   4. no merges since the last tag exits cleanly with a message, not an error
// plus the invalid-bump error path, and the idempotent/version-aware criteria:
//   - a computed tag that already exists exits cleanly, creating nothing (AC1)
//   - a dangling tag from a partial run advances the version, not collides (AC2)
//   - the first-ever release seeds from .ratchet-version, not v0.0.1 (AC3)
//   - DOCS.md's pin-to-tag guidance no longer promises tags that may not exist (AC4)
// plus #81 (stop treating every 422 as a tag collision; target the default branch):
//   - a non-collision 422 (invalid target_commitish) fails loudly, not as a no-op
//   - the release targets the repository's default branch (master), not a hardcoded main

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "./release.mjs";

const respond = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "Not Found" });
const fail = (status, data) => ({ ok: false, status, json: async () => data, text: async () => JSON.stringify(data) });
// A real GitHub tag-collision 422: errors[] names field:"tag_name", code:"already_exists".
const conflict = () => fail(422, { message: "Validation Failed", errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }] });
// A real GitHub invalid-target 422 (e.g. target_commitish naming no branch): same
// status, different errors[] — must NOT be mistaken for a benign tag collision.
const badTarget = () => fail(422, { message: "Validation Failed", errors: [{ resource: "Release", code: "invalid", field: "target_commitish" }] });

// Build an in-memory GitHub API. `latest` is the /releases/latest payload (or
// null for a 404 — no releases yet); `pulls` is page 1 of closed PRs; `tags` is
// the list of tag names; `existingTags` are tags whose git ref resolves (the
// pre-flight collision check); `failCreate` makes the release POST return a
// tag-collision 422; `createResponse`, when set, overrides the POST response
// (e.g. an invalid-target 422); `defaultBranch` is the repo's default branch.
// Created releases are captured for assertions, with extra arrays attached for
// the bump PR path: `created.pullRequests`, `created.trees`, `created.refs`.
function mockGitHub({
  latest,
  pulls,
  tags = [],
  existingTags = null,
  failCreate = false,
  createResponse = null,
  defaultBranch = "main",
  failBranch = false,
  failPull = false,
}) {
  const refTags = existingTags ?? tags;
  const created = [];
  const pullRequests = [];
  const trees = [];
  const refs = new Map([[`refs/heads/${defaultBranch}`, "base-sha"]]);
  created.pullRequests = pullRequests;
  created.trees = trees;
  created.refs = refs;
  const contents = {
    ".ratchet-version": "3.6.0\n",
    "plugin/.claude-plugin/plugin.json": `${JSON.stringify({ name: "ratchet", version: "3.6.0" }, null, 2)}\n`,
    "README.md": "![framework version](https://img.shields.io/badge/framework-v3.6.0-ea8f3c)\n",
    "DOCS.md": "Version 3.6.0 · MIT\n",
  };
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === "GET" && pathname === "/repos/o/r") {
      return respond({ default_branch: defaultBranch });
    }
    if (method === "GET" && pathname === `/repos/o/r/git/ref/heads/${defaultBranch}`) {
      return respond({ object: { sha: refs.get(`refs/heads/${defaultBranch}`) } });
    }
    if (method === "GET" && pathname === "/repos/o/r/git/commits/base-sha") {
      return respond({ sha: "base-sha", tree: { sha: "base-tree" } });
    }
    if (method === "POST" && pathname === "/repos/o/r/git/refs") {
      if (failBranch || refs.has(body.ref)) {
        return fail(422, { message: "Reference already exists" });
      }
      refs.set(body.ref, body.sha);
      return respond({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (method === "GET" && pathname.startsWith("/repos/o/r/contents/")) {
      const file = decodeURIComponent(pathname.slice("/repos/o/r/contents/".length));
      if (!Object.hasOwn(contents, file)) return notFound();
      return respond({ content: Buffer.from(contents[file], "utf8").toString("base64") });
    }
    if (method === "POST" && pathname === "/repos/o/r/git/trees") {
      trees.push(body);
      return respond({ sha: `tree-${trees.length}` }, 201);
    }
    if (method === "POST" && pathname === "/repos/o/r/git/commits") {
      return respond({ sha: "commit-1" }, 201);
    }
    if (method === "PATCH" && pathname.startsWith("/repos/o/r/git/refs/heads/")) {
      const branch = decodeURIComponent(pathname.slice("/repos/o/r/git/refs/heads/".length));
      refs.set(`refs/heads/${branch}`, body.sha);
      return respond({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }
    if (method === "POST" && pathname === "/repos/o/r/pulls") {
      if (failPull) return fail(422, { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] });
      pullRequests.push(body);
      return respond({ ...body, html_url: `https://github.com/o/r/pull/${pullRequests.length}` }, 201);
    }
    if (method === "GET" && pathname === "/repos/o/r/releases/latest") {
      return latest === null ? notFound() : respond(latest);
    }
    if (method === "GET" && pathname === "/repos/o/r/pulls") {
      return respond(Number(searchParams.get("page")) === 1 ? pulls : []);
    }
    if (method === "GET" && pathname === "/repos/o/r/tags") {
      return respond(Number(searchParams.get("page")) === 1 ? tags.map((name) => ({ name })) : []);
    }
    if (method === "GET" && pathname.startsWith("/repos/o/r/git/ref/tags/")) {
      const tag = decodeURIComponent(pathname.slice("/repos/o/r/git/ref/tags/".length));
      return refTags.includes(tag) ? respond({ ref: `refs/tags/${tag}` }) : notFound();
    }
    if (method === "POST" && pathname === "/repos/o/r/releases") {
      if (createResponse) return createResponse();
      if (failCreate) return conflict();
      created.push(body);
      return respond({ ...body, html_url: `https://github.com/o/r/releases/tag/${body.tag_name}` }, 201);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return created;
}

function assertVersionTree(created, version) {
  assert.equal(created.trees.length, 1, "one version bump tree is created");
  const entries = new Map(created.trees[0].tree.map((entry) => [entry.path, entry.content]));
  assert.equal(entries.get(".ratchet-version"), `${version}\n`, ".ratchet-version carries released version");
  assert.equal(JSON.parse(entries.get("plugin/.claude-plugin/plugin.json")).version, version, "plugin manifest carries released version");
  assert.ok(entries.get("README.md").includes(`framework-v${version}`), "README badge carries released version");
  assert.ok(entries.get("DOCS.md").startsWith(`Version ${version}`), "DOCS header carries released version");
}

// Capture console.log for message assertions; returns the collected lines.
function captureLogs(fn) {
  const logs = [];
  const real = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.log = real; })
    .then((result) => ({ result, logs }));
}

// The tests share the real .ratchet-version file (read by the seed path). Back
// up its original state and restore it no matter how the run ends, so a crash
// mid-test never leaves the working tree dirty.
const SEED_FILE = fileURLToPath(new URL("../.ratchet-version", import.meta.url));
const OUTPUT_FILE = fileURLToPath(new URL("../.release-test-output", import.meta.url));
const seedExisted = existsSync(SEED_FILE);
const seedOriginal = seedExisted ? readFileSync(SEED_FILE, "utf8") : null;
const setSeed = (value) => (value === null ? rmSync(SEED_FILE, { force: true }) : writeFileSync(SEED_FILE, value));
const restoreSeed = () => (seedExisted ? writeFileSync(SEED_FILE, seedOriginal) : rmSync(SEED_FILE, { force: true }));
const resetOutput = () => { rmSync(OUTPUT_FILE, { force: true }); process.env.GITHUB_OUTPUT = OUTPUT_FILE; };
const readOutput = () => (existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, "utf8") : "");

process.env.GITHUB_TOKEN = "test-token";
process.env.GITHUB_REPOSITORY = "o/r";

try {
  // --- 1. tags the next version and builds a changelog from PR titles ---------
  process.env.RELEASE_BUMP = "minor";
  let created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3"],
    pulls: [
      { number: 42, title: "Add feature X", merged_at: "2026-02-01T00:00:00Z" },
      { number: 41, title: "Fix bug Y", merged_at: "2026-01-15T00:00:00Z" },
      { number: 40, title: "Old thing before the tag", merged_at: "2025-12-01T00:00:00Z" },
      { number: 39, title: "Never merged", merged_at: null },
    ],
  });
  resetOutput();
  let result = await main();
  assert.equal(result.released, true, "a batch of merged PRs must produce a release");
  assert.equal(created.length, 1, "exactly one release is created");
  assert.equal(created.pullRequests.length, 1, "one reviewable version bump PR is opened");
  assert.equal(created.pullRequests[0].base, "main", "the bump PR targets the repo's default branch");
  assert.equal(created.pullRequests[0].head, "release/v1.3.0", "the bump PR comes from the release branch");
  assert.equal(created[0].target_commitish, "commit-1", "the release tag targets the bumped commit, not the stale branch head");
  assert.equal(created.refs.get("refs/heads/main"), "base-sha", "the release lane never updates the default branch directly");
  assert.equal(created[0].tag_name, "v1.3.0", `minor bump of v1.2.3 must be v1.3.0, got ${created[0].tag_name}`);
  assertVersionTree(created, "1.3.0");
  assert.ok(created[0].body.includes("Add feature X (#42)"), "changelog must list a merged PR by title and number");
  assert.ok(created[0].body.includes("Fix bug Y (#41)"), "changelog must list every PR merged since the last tag");
  assert.ok(!created[0].body.includes("Old thing"), "PRs merged before the last tag are excluded");
  assert.ok(!created[0].body.includes("Never merged"), "unmerged PRs are excluded");
  assert.match(readOutput(), /^released=true$/m, "a published release must expose released=true to the workflow");
  assert.match(readOutput(), /^version=v1\.3\.0$/m, "a published release must expose the version to deploy");
  assert.match(readOutput(), /^bump_pr_url=https:\/\/github\.com\/o\/r\/pull\/1$/m, "a published release exposes the bump PR URL");

  // --- 4. no merges since the last tag: clean exit, a message, no error --------
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.3.0", published_at: "2026-03-01T00:00:00Z" },
    tags: ["v1.3.0"],
    pulls: [{ number: 50, title: "Merged long ago", merged_at: "2026-02-01T00:00:00Z" }],
  });
  resetOutput();
  ({ result } = await captureLogs(main).then(({ result, logs }) => {
    assert.ok(logs.some((l) => l.includes("Nothing to release")), "a clear 'nothing to release' message is printed");
    return { result };
  }));
  assert.equal(result.released, false, "no PRs since the tag means nothing is released");
  assert.equal(created.length, 0, "no release is created when there is nothing to ship");
  assert.match(readOutput(), /^released=false$/m, "a no-op release must expose released=false so deploy is skipped");

  // --- AC3. first-ever release seeds its version from .ratchet-version ---------
  // No tags and no prior release: the version must come from .ratchet-version
  // (shipped as advertised), not the bare v0.0.1 the old code produced.
  process.env.RELEASE_BUMP = "patch";
  setSeed("3.3.6\n");
  created = mockGitHub({
    latest: null,
    tags: [],
    pulls: [{ number: 1, title: "Initial commit of the thing", merged_at: "2026-01-01T00:00:00Z" }],
  });
  result = await main();
  assert.equal(created.length, 1, "the first release is created");
  assert.equal(created[0].tag_name, "v3.3.6", `first release must seed from .ratchet-version (v3.3.6), got ${created[0].tag_name}`);
  assert.ok(created[0].body.includes("Initial commit of the thing (#1)"), "first changelog includes all merged PRs");

  // Seed fallback: with no .ratchet-version and no tags, fall back to v0.0.1.
  setSeed(null);
  created = mockGitHub({
    latest: null,
    tags: [],
    pulls: [{ number: 1, title: "Initial commit", merged_at: "2026-01-01T00:00:00Z" }],
  });
  result = await main();
  assert.equal(created[0].tag_name, "v0.0.1", `without .ratchet-version the first release bumps from v0.0.0, got ${created[0].tag_name}`);

  // Malformed .ratchet-version is a clear error on the first release, not a crash.
  setSeed("not-a-version\n");
  mockGitHub({ latest: null, tags: [], pulls: [{ number: 1, title: "x", merged_at: "2026-01-01T00:00:00Z" }] });
  await assert.rejects(
    () => main(),
    (e) => e.message.includes(".ratchet-version") && e.message.includes("not semver"),
    "a malformed .ratchet-version is rejected with a clear message",
  );
  restoreSeed();

  // --- AC2. a dangling tag from a partial run advances the version ------------
  // The last *release* is v1.2.3, but a tag v1.3.0 was left behind by a failed
  // run (no backing release). Numbering from tags must yield v1.3.1, cleanly —
  // never recompute v1.3.0 and 422.
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3", "v1.3.0"],
    pulls: [{ number: 60, title: "Work merged after the partial run", merged_at: "2026-02-01T00:00:00Z" }],
  });
  result = await main();
  assert.equal(result.released, true, "re-running after a partial failure still ships");
  assert.equal(created[0].tag_name, "v1.3.1", `must advance past the dangling v1.3.0 tag to v1.3.1, got ${created[0].tag_name}`);

  // --- AC1. a computed tag that already exists exits cleanly, creating nothing -
  // Pre-flight path: the target tag's ref exists (created since we listed tags).
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3"],
    existingTags: ["v1.2.3", "v1.2.4"], // v1.2.4 ref exists but is not yet in the tags list
    pulls: [{ number: 70, title: "New work", merged_at: "2026-02-01T00:00:00Z" }],
  });
  ({ result } = await captureLogs(main).then(({ result, logs }) => {
    assert.ok(logs.some((l) => l.includes("v1.2.4") && l.includes("already exists")), "a clear 'tag already exists' message is printed");
    return { result };
  }));
  assert.equal(result.released, false, "a colliding tag releases nothing");
  assert.equal(created.length, 0, "nothing partial is created when the tag already exists");

  // AC1 race path: the create call itself 422s (a concurrent run beat us). Still
  // a clean no-op, never an unhandled API error.
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3"],
    existingTags: ["v1.2.3"], // pre-flight sees no clash...
    failCreate: true, // ...but the POST loses the race and 422s
    pulls: [{ number: 71, title: "New work", merged_at: "2026-02-01T00:00:00Z" }],
  });
  ({ result } = await captureLogs(main).then(({ result, logs }) => {
    assert.ok(logs.some((l) => l.includes("already exists")), "a 422 on create prints a clear message, not a stack trace");
    return { result };
  }));
  assert.equal(result.released, false, "a create-time collision releases nothing");
  assert.equal(created.length, 0, "a create-time collision leaves nothing partial");

  // --- AC1. a non-collision 422 fails loudly with the API's real error ---------
  // GitHub also returns 422 for an invalid target_commitish. That is NOT a tag
  // collision and must never be swallowed as "another run beat us to it" — it
  // must fail with the actual API error so a mis-targeted release lane is seen.
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3"],
    createResponse: badTarget, // the POST 422s on target_commitish, not the tag
    pulls: [{ number: 72, title: "New work", merged_at: "2026-02-01T00:00:00Z" }],
  });
  await assert.rejects(
    () => main(),
    (e) => e.message.includes("422") && e.message.includes("target_commitish") && !e.message.includes("beat us"),
    "a 422 that is not a tag collision surfaces the API's actual error, never the benign no-op message",
  );

  // --- AC3. the release targets the repository's default branch ----------------
  // A repo whose default branch is `master` must cut a release targeting master,
  // not a hardcoded `main` (which would 422 as an invalid target_commitish).
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3"],
    defaultBranch: "master",
    pulls: [{ number: 73, title: "Work on a master-default repo", merged_at: "2026-02-01T00:00:00Z" }],
  });
  result = await main();
  assert.equal(result.released, true, "a master-default repo cuts a release");
  assert.equal(created.length, 1, "exactly one release is created on a master-default repo");
  assert.equal(created.pullRequests.length, 1, "a master-default repo opens the bump PR");
  assert.equal(created.pullRequests[0].base, "master", "the bump PR targets master, not hardcoded main");
  assert.equal(created.refs.get("refs/heads/master"), "base-sha", "the release lane never updates master directly");
  assert.equal(created[0].target_commitish, "commit-1", `the release must target the bumped commit, got ${created[0].target_commitish}`);
  assertVersionTree(created, "1.2.4");

  // --- AC4. bump branch creation failure aborts before publishing a tag -------
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3"],
    failBranch: true,
    pulls: [{ number: 74, title: "New work", merged_at: "2026-02-01T00:00:00Z" }],
  });
  await assert.rejects(
    () => main(),
    (e) => e.message.includes("Reference already exists"),
    "a branch creation failure surfaces GitHub's real message",
  );
  assert.equal(created.length, 0, "branch creation failure must not publish a release/tag");
  assert.equal(created.pullRequests.length, 0, "branch creation failure must not open a PR");

  // --- AC4. bump PR creation failure aborts before publishing a tag -----------
  process.env.RELEASE_BUMP = "patch";
  created = mockGitHub({
    latest: { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    tags: ["v1.2.3"],
    failPull: true,
    pulls: [{ number: 75, title: "New work", merged_at: "2026-02-01T00:00:00Z" }],
  });
  await assert.rejects(
    () => main(),
    (e) => e.message.includes("Validation Failed") && e.message.includes("head"),
    "a PR creation failure surfaces GitHub's real message",
  );
  assert.equal(created.length, 0, "PR creation failure must not publish a release/tag");

  // --- invalid bump: a clear error, not a stack trace --------------------------
  process.env.RELEASE_BUMP = "sideways";
  mockGitHub({ latest: null, tags: [], pulls: [] });
  await assert.rejects(
    () => main(),
    (e) => e.message.includes("sideways") && e.message.includes("major, minor, or patch"),
    "an invalid RELEASE_BUMP is rejected with a message naming the valid values",
  );
  delete process.env.RELEASE_BUMP;

  // --- 2. safe default: the workflow job is gated on RATCHET_RELEASE -----------
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)), "utf8");
  assert.ok(workflow.includes("vars.RATCHET_RELEASE == 'true'"), "the release job must be gated on RATCHET_RELEASE (off by default)");
  assert.ok(workflow.includes("workflow_dispatch"), "the release lane runs on demand");
  assert.ok(workflow.includes("pull-requests: write"), "the release workflow can open the reviewable version bump PR");
  assert.ok(workflow.includes("github.event.repository.default_branch"), "checkout must follow the repo default branch, not hardcoded main");

  // --- #62. deploy gate is opt-in, post-publish, and visibly failing ----------
  assert.ok(workflow.includes("vars.RATCHET_DEPLOY == 'true'"), "deploy must be gated on explicit RATCHET_DEPLOY opt-in");
  assert.ok(workflow.includes("steps.publish.outputs.released == 'true'"), "deploy must run only after release.mjs published a release");
  assert.ok(workflow.includes("RATCHET_DEPLOY_COMMAND is empty"), "missing deploy command after opt-in must fail visibly");
  assert.ok(!/^  deploy:/m.test(workflow), "repos that do not opt in must not get a separate deploy job");
  assert.ok(!/delete|remove/i.test(workflow.match(/- name: Deploy[\s\S]*/)?.[0] || ""), "deploy step must not delete or mutate the tag/release on failure");

  // --- AC4. DOCS.md pin-to-tag guidance matches reality ------------------------
  const docs = readFileSync(fileURLToPath(new URL("../DOCS.md", import.meta.url)), "utf8");
  assert.ok(
    !docs.includes("git tag v1.2.0 && git push --tags"),
    "DOCS.md no longer instructs pinning to tags cut by hand outside the release lane",
  );
  assert.ok(
    /released.*tag|tag.*actually released|opt-in release lane/i.test(docs),
    "DOCS.md conditions tag-pinning on a version having actually been released",
  );
  assert.ok(
    docs.includes("RATCHET_DEPLOY=true") && docs.includes("RATCHET_DEPLOY_COMMAND"),
    "DOCS.md documents the explicit deploy opt-in and command setting",
  );
  assert.ok(
    /no deploy job and no deploy config/i.test(docs),
    "DOCS.md says repos that do not opt in have no deploy job or required config",
  );
  assert.ok(
    /deploy fails[\s\S]*visibly red[\s\S]*does not delete or mutate the tag\/release/i.test(docs),
    "DOCS.md documents failed deploy semantics without rollback mutation",
  );

  // ==========================================================================
  // Issue #324 — the documented install path, provably wired end to end.
  // Exactly one test per acceptance criterion, named after it.
  // ==========================================================================
  const releaseYml = readFileSync(fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)), "utf8");
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const docsMd = readFileSync(fileURLToPath(new URL("../DOCS.md", import.meta.url)), "utf8");
  const thisTest = readFileSync(fileURLToPath(import.meta.url), "utf8");

  // criterion 1: the released tag's version matches .ratchet-version. With no
  // existing tags the first release seeds its version from the file, so the
  // published tag is exactly `v` + its contents — never a guessed number.
  process.env.RELEASE_BUMP = "patch";
  setSeed("4.5.0\n");
  created = mockGitHub({ latest: null, tags: [], pulls: [{ number: 90, title: "First ship", merged_at: "2026-02-01T00:00:00Z" }] });
  resetOutput();
  result = await main();
  assert.equal(created.length, 1, "criterion 1: a first release is published");
  assert.equal(created[0].tag_name, "v4.5.0", "criterion 1: the release tag matches .ratchet-version (v4.5.0)");
  restoreSeed();

  // criterion 2: a post-publish smoke check fetches bootstrap.sh at the new tag
  // over HTTPS and dry-runs it, failing the workflow visibly on any error.
  const smoke = releaseYml.match(/- name: Smoke-test the published install path[\s\S]*?(?=\n      - name:)/)?.[0] || "";
  assert.ok(smoke, "criterion 2: a smoke-test step exists");
  assert.ok(/steps\.publish\.outputs\.released == 'true'/.test(smoke), "criterion 2: the smoke test runs only after a release is published");
  assert.ok(/raw\.githubusercontent\.com\/\$\{INSTALL_REPO\}\/\$\{RELEASE_TAG\}\/scripts\/bootstrap\.sh/.test(smoke), "criterion 2: it fetches bootstrap.sh from the new tag over HTTPS");
  assert.ok(/--dry-run/.test(smoke), "criterion 2: it runs bootstrap in dry-run, writing nothing");
  assert.ok(/set -euo pipefail/.test(smoke) && /curl -fsSL/.test(smoke), "criterion 2: a failed fetch or run fails the workflow visibly");

  // criterion 3: the README/DOCS install command runs verbatim from a ref that is
  // guaranteed to exist (the latest release), with no `<tag>` placeholder to fill.
  for (const [name, doc] of [["README.md", readme], ["DOCS.md", docsMd]]) {
    assert.ok(!doc.includes("Ratchet/<tag>/scripts/bootstrap.sh"), `criterion 3: ${name} bootstrap fetch URL has no <tag> placeholder`);
    assert.ok(!/--version <tag>/.test(doc), `criterion 3: ${name} --version has no <tag> placeholder`);
    assert.ok(/releases\/latest/.test(doc) && /tag_name/.test(doc), `criterion 3: ${name} resolves the ref from the latest release (a ref guaranteed to exist)`);
  }

  // criterion 4: when RATCHET_RELEASE is not "true", the run reports the skip and
  // why, instead of silently doing nothing.
  assert.ok(/report-skip:/.test(releaseYml), "criterion 4: a companion job reports the skip");
  assert.ok(/if: \$\{\{ vars\.RATCHET_RELEASE != 'true' \}\}/.test(releaseYml), "criterion 4: it runs exactly when the release lane is off");
  assert.ok(/Release skipped/.test(releaseYml), "criterion 4: it announces that the release was skipped and why");
  assert.ok(/gh variable set RATCHET_RELEASE --body true/.test(releaseYml), "criterion 4: it names the fix to enable releases");

  // criterion 5: every criterion above has exactly one test named after it. Each
  // criterion's test is a single block introduced by one `// criterion N:`
  // comment, so exactly one such marker per N is the machine-checkable form of
  // "one test, named after the criterion".
  for (let n = 1; n <= 5; n++) {
    const named = (thisTest.match(new RegExp(`// criterion ${n}:`, "g")) || []).length;
    assert.equal(named, 1, `criterion 5: criterion ${n} has exactly one test named after it (found ${named})`);
  }

  console.log("PASS release.test.mjs (61 assertions)");
} finally {
  delete process.env.GITHUB_OUTPUT;
  rmSync(OUTPUT_FILE, { force: true });
  restoreSeed();
}

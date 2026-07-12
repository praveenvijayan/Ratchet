#!/usr/bin/env node
// gh-api.test.mjs — the acceptance criteria of issue #341 are the test plan.
// One test per criterion, exercised through the public interface (ghClient,
// paginate, resolveAuth) that the migrated scripts will call. Everything runs
// off the network and without a real `gh`: fetch is stubbed and the command
// runner is injected.
// Zero dependencies. Run:  node scripts/gh-api.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { ghClient, paginate, resolveAuth, API, API_VERSION } from "./gh-api.mjs";

// A fetch stub: records calls, replies from a queued script of responses.
function stubResponse({ ok = true, status = 200, json = null, text = "" }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text,
  };
}

// --- #341 Criterion 1: ghClient returns the request function with the current
// headers (Bearer auth, application/vnd.github+json, API version), 204-to-null
// handling, and an error carrying `status` and the response text. ------------
{
  const calls = [];
  const responses = [
    stubResponse({ json: { ok: 1 } }), // normal 200
    stubResponse({ status: 204 }), //     204 -> null
    stubResponse({ ok: false, status: 422, text: "Reference already exists" }),
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responses.shift();
  };
  const gh = ghClient("tok123", { fetchImpl });

  const body = await gh("POST", "/repos/x/y/issues", { title: "hi" });
  assert.deepEqual(body, { ok: 1 }, "a 2xx JSON body is parsed and returned");

  const h = calls[0].init.headers;
  assert.equal(h.Authorization, "Bearer tok123", "Authorization is Bearer <token>");
  assert.equal(h.Accept, "application/vnd.github+json", "Accept requests the v3 JSON media type");
  assert.equal(h["X-GitHub-Api-Version"], API_VERSION, "the pinned API version header is sent");
  assert.equal(calls[0].url, `${API}/repos/x/y/issues`, "the path is joined onto the API base");
  assert.equal(calls[0].init.body, JSON.stringify({ title: "hi" }), "a body is JSON-serialised");

  const empty = await gh("DELETE", "/repos/x/y/labels/z");
  assert.equal(empty, null, "a 204 No Content resolves to null");

  await assert.rejects(
    () => gh("POST", "/repos/x/y/git/refs"),
    (err) => {
      assert.equal(err.status, 422, "the thrown error carries the numeric HTTP status");
      assert.match(err.message, /422 Reference already exists/, "the error message carries the response text");
      return true;
    },
    "a non-2xx response throws an error carrying status and text",
  );
}

// --- #341 Criterion 2: paginate follows per_page=100 pages until a short batch
// and returns the concatenated results — the exact union of batches, in order,
// for 0-, 1-, and 3-page responses. ------------------------------------------
{
  // Drive paginate with an in-memory (method, path) => batch, recording paths.
  const run = async (pages) => {
    const seen = [];
    const gh = async (_method, path) => {
      seen.push(path);
      return pages.shift() ?? [];
    };
    const out = await paginate(gh, "/repos/x/y/issues");
    return { out, seen };
  };

  // 0 pages: first batch is short (empty) -> one request, empty union.
  const zero = await run([[]]);
  assert.deepEqual(zero.out, [], "an empty first page yields an empty result");
  assert.equal(zero.seen.length, 1, "a short first page stops after one request");
  assert.match(zero.seen[0], /\?per_page=100&page=1$/, "the first page carries per_page=100&page=1");

  // 1 page: a single short (<100) batch.
  const one = await run([[1, 2, 3]]);
  assert.deepEqual(one.out, [1, 2, 3], "a single short page returns exactly that batch");
  assert.equal(one.seen.length, 1, "a short page stops paginating");

  // 3 pages: two full 100-item batches then a short tail; union in order.
  const full1 = Array.from({ length: 100 }, (_, i) => i);
  const full2 = Array.from({ length: 100 }, (_, i) => 100 + i);
  const tail = [200, 201];
  const three = await run([full1, full2, tail]);
  assert.deepEqual(three.out, [...full1, ...full2, ...tail], "three pages concatenate in page order");
  assert.equal(three.seen.length, 3, "pagination continues while batches are full and stops on the short tail");
  assert.match(three.seen[1], /&page=2$/, "page numbers increment");
}

// --- #341 Criterion 3: resolveAuth resolves the token in order GITHUB_TOKEN,
// then GITHUB_PAT (environment or .env), then `gh auth token`, and the repo in
// order GITHUB_REPOSITORY, then `gh repo view`, throwing one clear error naming
// what is missing. -----------------------------------------------------------
{
  const noRun = () => undefined; // `gh` unavailable

  // GITHUB_TOKEN wins over everything.
  assert.deepEqual(
    resolveAuth({
      env: { GITHUB_TOKEN: "envtok", GITHUB_PAT: "pat", GITHUB_REPOSITORY: "o/r" },
      readEnv: () => ({}),
      runCommand: noRun,
    }),
    { token: "envtok", repo: "o/r" },
    "GITHUB_TOKEN takes precedence over GITHUB_PAT",
  );

  // GITHUB_PAT via .env when the environment has no token; repo from .env too.
  assert.deepEqual(
    resolveAuth({
      env: {},
      readEnv: () => ({ GITHUB_PAT: "dotpat", GITHUB_REPOSITORY: "o/r" }),
      runCommand: noRun,
    }),
    { token: "dotpat", repo: "o/r" },
    "GITHUB_PAT and the repo are read from .env when the environment lacks them",
  );

  // Fall through to the gh CLI for both token and repo.
  const ghRun = (cmd, args) => {
    assert.equal(cmd, "gh", "the CLI fallback shells out to gh");
    if (args[0] === "auth") return "clitok";
    if (args[0] === "repo") return "o/from-gh";
    return undefined;
  };
  assert.deepEqual(
    resolveAuth({ env: {}, readEnv: () => ({}), runCommand: ghRun }),
    { token: "clitok", repo: "o/from-gh" },
    "token falls back to `gh auth token` and repo to `gh repo view`",
  );

  // Failure path — no token anywhere: distinct, actionable message.
  assert.throws(
    () => resolveAuth({ env: {}, readEnv: () => ({}), runCommand: noRun }),
    /Missing GitHub token/,
    "no token anywhere throws a token-specific error",
  );

  // Failure path — token present but no repo: a different, repo-specific message.
  assert.throws(
    () => resolveAuth({ env: { GITHUB_TOKEN: "t" }, readEnv: () => ({}), runCommand: noRun }),
    /Missing GitHub repository/,
    "a token with no repo throws a repo-specific error",
  );
}

// --- #341 Criterion 4: fetchImpl and the command runner are injectable so
// tests exercise the module without network or a real `gh`. This test proves
// injection is honoured: the only fetch/command invocations are the injected
// stubs, and each is actually reached. --------------------------------------
{
  let fetched = 0;
  let commanded = 0;
  const fetchImpl = async () => {
    fetched++;
    return stubResponse({ json: [] });
  };
  const gh = ghClient("tok", { fetchImpl });
  await gh("GET", "/anything");
  assert.equal(fetched, 1, "ghClient uses the injected fetchImpl, never the global fetch");

  const runCommand = (cmd, args) => {
    commanded++;
    return args[0] === "auth" ? "t" : "o/r";
  };
  const auth = resolveAuth({ env: {}, readEnv: () => ({}), runCommand });
  assert.deepEqual(auth, { token: "t", repo: "o/r" }, "resolveAuth uses the injected command runner");
  assert.ok(commanded >= 1, "the injected runner is the only path to `gh`");
}

// --- #341 Criterion 5: scripts/gh-api.mjs is listed in ratchet-manifest.json
// (and manifest-check.mjs — run as its own gate — proves the manifest is
// consistent with the repo). ------------------------------------------------
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "ratchet-manifest.json"), "utf8"));
  const listed = manifest.files.some((f) => f.path === "scripts/gh-api.mjs");
  assert.ok(listed, "ratchet-manifest.json lists scripts/gh-api.mjs");
}

// --- #341 Criterion 6: every criterion above has exactly one test named after
// it. Counts this file's own `#341 Criterion N` markers and proves there is
// exactly one per criterion, 1..6 — it never reads the plan file at runtime. --
{
  const CRITERIA_COUNT = 6;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #341 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #341 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #341 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#341 criterion ${n} has a test`);
}

console.log("PASS gh-api.test.mjs");

// ===========================================================================
// Issue #342 (plan 0151-migrate-gh-api-verdict-scripts): the first three
// consumers — unblock-dependents.mjs, review-verdict.mjs, and
// review-verdict-sweep.mjs — drop their byte-identical private clients and
// adopt this module. Its acceptance criteria live here, beside the client they
// migrate onto, one test per criterion and self-counted. `#342` markers are
// distinct from the `#341` markers counted above, so the two never collide.
// ===========================================================================

// The three scripts this migration touches, with the shared symbols each uses.
// review-verdict.mjs issues single reads only, so it needs no paginate.
const MIGRATED = [
  { file: "unblock-dependents.mjs", uses: ["ghClient", "paginate", "resolveAuth"] },
  { file: "review-verdict.mjs", uses: ["ghClient", "resolveAuth"] },
  { file: "review-verdict-sweep.mjs", uses: ["ghClient", "paginate", "resolveAuth"] },
];
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const readScript = (name) => readFileSync(join(scriptsDir, name), "utf8");

// --- #342 Criterion 1: all three scripts import the shared client from
// scripts/gh-api.mjs and define no private fetch client, token resolution, or
// pagination loop of their own. ---------------------------------------------
{
  for (const { file, uses } of MIGRATED) {
    const src = readScript(file);
    const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/gh-api\.mjs["']/);
    assert.ok(importMatch, `${file} imports from ./gh-api.mjs`);
    const imported = importMatch[1].split(",").map((s) => s.trim());
    for (const sym of uses) {
      assert.ok(imported.includes(sym), `${file} imports ${sym} from the shared client`);
    }
    assert.doesNotMatch(src, /https:\/\/api\.github\.com/, `${file} no longer hard-codes the API base`);
    assert.doesNotMatch(src, /function\s+ghClient\b/, `${file} defines no private ghClient`);
    assert.doesNotMatch(src, /function\s+paginate\b/, `${file} defines no private pagination loop`);
    assert.doesNotMatch(
      src,
      /process\.env\.GITHUB_TOKEN\s*\|\|\s*process\.env\.GITHUB_PAT/,
      `${file} does no private token resolution`,
    );
  }
}

// --- #342 Criterion 2: each script's existing behaviour suite passes unchanged
// in what it asserts — run all three as subprocesses and require exit 0. This
// file is not one of the three, so no suite re-runs itself. ------------------
{
  for (const { file } of MIGRATED) {
    const testFile = file.replace(/\.mjs$/, ".test.mjs");
    let status = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [join(scriptsDir, testFile)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      status = e.status ?? 1;
      out = `${e.stdout || ""}${e.stderr || ""}`;
    }
    assert.equal(status, 0, `${testFile} must still pass after the migration:\n${out}`);
  }
}

// --- #342 Criterion 3: a missing token or repository surfaces the shared
// client's single clear error message from every migrated script's main(). ---
{
  const noToken = { env: {}, readEnv: () => ({}), runCommand: () => undefined };
  const noRepo = { env: { GITHUB_TOKEN: "t" }, readEnv: () => ({}), runCommand: () => undefined };
  for (const { file } of MIGRATED) {
    const { main } = await import(`./${file}`);
    await assert.rejects(
      () => main({ auth: () => resolveAuth(noToken) }),
      /Missing GitHub token/,
      `${file} surfaces the shared client's missing-token error`,
    );
    await assert.rejects(
      () => main({ auth: () => resolveAuth(noRepo) }),
      /Missing GitHub repository/,
      `${file} surfaces the shared client's missing-repository error`,
    );
  }
}

// --- #342 Criterion 4: every criterion above has exactly one test named after
// it — count this file's own `#342 Criterion N` markers, 1..4. ---------------
{
  const CRITERIA_342 = 4;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #342 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #342 criterion tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_342, `exactly ${CRITERIA_342} #342 criterion markers are present`);
  for (let n = 1; n <= CRITERIA_342; n++) assert.ok(unique.has(n), `#342 criterion ${n} has a test`);
}

console.log("PASS gh-api.test.mjs #342 verdict-script migration (4 criteria)");

// ===========================================================================
// Issue #344 (plan 0153-migrate-gh-api-sync-scripts): plan-sync.mjs,
// archive-closed-plans.mjs, and release.mjs adopt this module. release relied
// on a private client that tolerates 404, so `ghClient` gains an `allow404`
// option — exercised here so it is covered by the shared module's own suite.
// `#344` markers are distinct from the `#341`/`#342` markers counted above.
// ===========================================================================

const MIGRATED_344 = ["plan-sync.mjs", "archive-closed-plans.mjs", "release.mjs"];
const readScript344 = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), "utf8");

// --- #344 Criterion 1: all three scripts import ghClient/paginate/resolveAuth
// from scripts/gh-api.mjs and keep no private client, token resolution, or
// pagination loop. -----------------------------------------------------------
{
  for (const file of MIGRATED_344) {
    const src = readScript344(file);
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/gh-api\.mjs["']/);
    assert.ok(m, `${file} imports from ./gh-api.mjs`);
    const imported = m[1].split(",").map((s) => s.trim());
    for (const sym of ["ghClient", "paginate", "resolveAuth"]) {
      assert.ok(imported.includes(sym), `${file} imports ${sym} from the shared client`);
    }
    assert.doesNotMatch(src, /https:\/\/api\.github\.com/, `${file} no longer hard-codes the API base`);
    assert.doesNotMatch(src, /function\s+gh\b/, `${file} defines no private gh client`);
    assert.doesNotMatch(src, /per_page=100&page=/, `${file} runs no private pagination loop`);
    assert.doesNotMatch(src, /GITHUB_TOKEN\s*\|\|\s*process\.env\.GITHUB_PAT/, `${file} does no private token resolution`);
  }
}

// --- #344 Criterion 2: the shared client provides the `allow404` option
// release.mjs relies on — a 404 with allow404 resolves to null; without it a
// 404 throws, carrying `status` and the raw `body`. --------------------------
{
  const ghFor = (status, text) => ghClient("tok", { fetchImpl: async () => stubResponse({ ok: status < 400, status, text }) });
  assert.equal(
    await ghFor(404, "Not Found")("GET", "/repos/o/r/releases/latest", undefined, { allow404: true }),
    null,
    "a 404 with allow404 resolves to null instead of throwing",
  );
  await assert.rejects(
    () => ghFor(404, "Not Found")("GET", "/repos/o/r/releases/latest"),
    (err) => err.status === 404 && err.body === "Not Found",
    "a 404 without allow404 throws, carrying status 404 and the raw body",
  );
}

// --- #344 Criterion 3: each script's existing behaviour suite passes unchanged
// in what it asserts — run all three as subprocesses and require exit 0. ------
{
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of MIGRATED_344) {
    const testFile = file.replace(/\.mjs$/, ".test.mjs");
    let status = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [join(here, testFile)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      status = e.status ?? 1;
      out = `${e.stdout || ""}${e.stderr || ""}`;
    }
    assert.equal(status, 0, `${testFile} must still pass after the migration:\n${out}`);
  }
}

// --- #344 Criterion 4: every criterion above has exactly one test named after
// it — count this file's own `#344 Criterion N` markers, 1..4. ---------------
{
  const markers = [...readScript344("gh-api.test.mjs").matchAll(/^\/\/ --- #344 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #344 criterion tested exactly once");
  assert.equal(markers.length, 4, "exactly 4 #344 criterion markers are present");
  for (let n = 1; n <= 4; n++) assert.ok(unique.has(n), `#344 criterion ${n} has a test`);
}

console.log("PASS gh-api.test.mjs #344 sync-script migration (4 criteria)");

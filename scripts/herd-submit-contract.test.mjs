#!/usr/bin/env node
// herd-submit-contract.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #425 (plan 0176-herd-worker-pr-gates-contract):
// headless workers must open their PR through ratchet-submit with a body that
// carries a `Closes #<N>` line and a gates section, so the herd's verify stage
// reaches "ready for review" instead of escalating on a missing gates section.
//
// Everything runs offline: ratchet-submit's git/gate/GitHub deps are injected,
// herd-verify's gh and spawn are injected, so no network, no real git, no real
// worker. The submit path and the verify path are driven through their public
// interfaces (run() and verifyOnce()), never against internals.
// Zero dependencies. Run:  node scripts/herd-submit-contract.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfig } from "./herd.mjs";
import { buildDispatch } from "./herd-dispatch.mjs";
import { run as submit } from "./ratchet-submit.mjs";
import { verifyOnce, hasClosesRef, hasGatesSection } from "./herd-verify.mjs";
import { readState } from "./herd-survey.mjs";

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const ISSUE = 425;
const PINNED_DISPATCH_RULES = readFileSync(
  fileURLToPath(new URL("../.agents/skills/ratchet-herd/SKILL.md", import.meta.url)),
  "utf8",
);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIRROR_PATHS = [
  fileURLToPath(new URL("../.claude/skills/ratchet-herd/SKILL.md", import.meta.url)),
  fileURLToPath(new URL("../plugin/skills/ratchet-herd/SKILL.md", import.meta.url)),
];

// The body a worker writes per the contract: a `Closes #<N>` first line and a
// `## Gates` section. ratchet-submit relays this model-authored body verbatim.
const CONTRACT_BODY = `Closes #${ISSUE}\n\nA model-authored summary of the change.\n\n## Gates\n- test: pass\n`;

// Injected git: integrated (origin/main is an ancestor of HEAD), push succeeds.
const okGit = (args) => {
  const j = args.join(" ");
  if (j.startsWith("merge-base --is-ancestor")) return { code: 0, stdout: "" };
  return { code: 0, stdout: "" };
};

// In-memory GitHub API for ratchet-submit: no open PR yet, so it POSTs one and
// we capture the exact body it hands GitHub. Labels flip to state:in-review.
function mkSubmitApi() {
  const capture = { postedBody: null, labels: null };
  const issue = { title: "Headless workers open PRs through ratchet-submit", labels: [{ name: "state:in-progress" }] };
  const respond = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  const fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname;
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (method === "GET" && p === "/repos/o/r/pulls") return respond([]);
    if (method === "POST" && p === "/repos/o/r/pulls") {
      capture.postedBody = body.body;
      return respond({ number: 100, head: { ref: body.head } }, 201);
    }
    if (method === "GET" && p === `/repos/o/r/issues/${ISSUE}`) return respond(issue);
    if (method === "PUT" && p === `/repos/o/r/issues/${ISSUE}/labels`) {
      capture.labels = body.labels;
      issue.labels = body.labels.map((n) => ({ name: n }));
      return respond(issue.labels);
    }
    throw new Error(`unexpected request: ${method} ${p}`);
  };
  return { fetch, capture };
}

// Drive ratchet-submit.run() with all deps stubbed; returns exit code + capture.
async function runSubmit(body = CONTRACT_BODY) {
  const api = mkSubmitApi();
  const out = [];
  const code = await submit({
    argv: ["--issue", String(ISSUE), "--body-file", "body.md"],
    auth: () => ({ token: "t", repo: "o/r" }),
    fetchImpl: api.fetch,
    runGit: okGit,
    runGates: () => 0,
    readBody: () => body,
    out: (s) => out.push(s),
    err: () => {},
  });
  return { code, out, capture: api.capture };
}

// herd-verify harness: a state file with one PR awaiting verification, and a gh
// stub that returns a given PR view. Records every gh call so we can prove the
// verify path never merges, closes, or labels.
const entry = (over = {}) => ({ adapter: "claude", pid: null, logFile: "logs/issue.log", attempts: 1, status: "awaiting-verification", pr: 100, ...over });
const mkConfig = () => ({
  maxWorkers: 3, pollSeconds: 60, reworkCap: 2, logDir: "logs",
  adapters: { claude: { launch: ["claude", "{prompt}"], promptTemplate: "issue {issue}", env: {} } },
  routing: { default: "claude", labels: {} },
});
const mkGh = (view, calls) => async (args) => {
  calls.push(args);
  if (args[0] === "pr" && args[1] === "view") return view;
  throw new Error(`unexpected gh call: ${args.join(" ")}`);
};
async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-submit-contract-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}
// One verify pass over a PR whose body is `body`; returns the resulting entry
// plus the recorded gh calls.
async function verifyBody(body) {
  return inTempDir(async () => {
    writeFileSync("s.json", JSON.stringify({ [ISSUE]: entry() }) + "\n");
    const calls = [];
    const r = await verifyOnce({
      config: mkConfig(),
      statePath: "s.json",
      escalationsPath: "esc.md",
      gh: mkGh({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", body }, calls),
      spawn: () => { throw new Error("a clean/text-failed PR is never dispatched"); },
      now: () => NOW,
      log: () => {},
    });
    return { state: readState("s.json")[String(ISSUE)], action: r.transitions[0].action, calls };
  });
}

// --- Criterion 1: the shipped default promptTemplate (both adapters) points
// workers at the canonical dispatch skill, whose contract directs them to open
// the PR via ratchet-submit, never raw `gh pr create`. -----------------------
{
  const { adapters } = defaultConfig();
  const entries = Object.entries(adapters);
  assert.ok(entries.length >= 2, "both shipped adapters are present");
  for (const [name, a] of entries) {
    assert.match(a.promptTemplate, /\.agents\/skills\/ratchet-herd\/SKILL\.md/, `${name}: points to the canonical dispatch skill`);
    assert.doesNotMatch(a.promptTemplate, /\bgh pr create\b(?!`)/, `${name}: never instructs a bare gh pr create`);
  }
  assert.match(PINNED_DISPATCH_RULES, /ratchet-submit\.mjs --issue/, "the dispatch skill directs the PR through ratchet-submit");
  assert.match(PINNED_DISPATCH_RULES, /never `gh pr create`/, "the dispatch skill forbids raw gh pr create");
}

// --- Criterion 2: the PR body ratchet-submit produces (relays to GitHub) passes
// herd-verify's `Closes #<N>` and gates-section text checks — the regression
// that shipped (bodies dead-ended on the missing gates section). -----------
{
  const { code, capture } = await runSubmit();
  assert.equal(code, 0, "submit through the contract path succeeds");
  assert.ok(capture.postedBody, "ratchet-submit produced a PR body for GitHub");
  assert.ok(hasClosesRef(capture.postedBody, ISSUE), "the produced body passes the Closes #<N> check");
  assert.ok(hasGatesSection(capture.postedBody), "the produced body passes the gates-section check");
}

// --- Criterion 3: an offline worker that succeeds and submits through the
// contract path takes its issue to review (state:in-review) and its PR to
// ready-for-review at verify — not escalated — with zero human intervention. -
{
  const { code, capture } = await runSubmit();
  assert.equal(code, 0, "the worker's submit succeeds headlessly");
  assert.deepEqual(capture.labels, ["state:in-review"], "submit flips the issue to state:in-review, no human step");
  const { state, action } = await verifyBody(capture.postedBody);
  assert.equal(state.status, "ready-for-review", "verify takes the submit-produced PR to ready-for-review");
  assert.equal(action, "escalate-ready", "the terminal transition is 'ready for review', not a body escalation");
  assert.notEqual(action, "escalate-body", "the contract path never dead-ends on a missing gates section");
}

// --- Criterion 4: a PR that nonetheless lacks a gates section still
// verify-escalates exactly as today — verify is not weakened, and the stage
// still only reads (`gh pr view`), never editing the PR body. --------------
{
  const { state, action, calls } = await verifyBody("A summary with a Closes #425 line but no gate checklist.");
  assert.equal(state.status, "verify-escalated", "a body missing a gates section still escalates");
  assert.equal(action, "escalate-body", "the escalation is the same body escalation as today");
  for (const call of calls) assert.deepEqual(call.slice(0, 2), ["pr", "view"], `verify only reads via 'gh pr view', saw: ${call.join(" ")}`);
}

// --- Criterion 5: DOCS.md's promptTemplate examples match the new default
// verbatim (both adapters), and the existing note that operators of existing
// .ratchet/herd.json files must update the template by hand is still there. -
{
  const docs = readFileSync(fileURLToPath(new URL("../DOCS.md", import.meta.url)), "utf8");
  const { adapters } = defaultConfig();
  for (const [name, a] of Object.entries(adapters))
    assert.ok(docs.includes(`"promptTemplate": ${JSON.stringify(a.promptTemplate)}`), `${name}: DOCS.md shows the new default promptTemplate verbatim`);
  assert.match(docs, /update the `promptTemplate` in yours by hand/, "DOCS.md keeps the by-hand update note for existing herd.json files");
}

// --- Criterion 6: every criterion above has exactly one test named after it.
// Counts the `Criterion N:` markers in this file — one, and only one, per N. -
{
  const CRITERIA_COUNT = 6;
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...self.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "no criterion is tested twice");
  assert.equal(markers.length, CRITERIA_COUNT, `exactly ${CRITERIA_COUNT} criteria are tested`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

// --- Issue #430 Criterion 1: pinned-dispatch rules live in the canonical
// skill and identical setup.sh mirrors, while the public parity guard passes -
{
  assert.match(PINNED_DISPATCH_RULES, /Issue \{issue\} is your entire assignment/);
  assert.match(PINNED_DISPATCH_RULES, /agent\/issue-\{issue\}.*prior claim/s);
  assert.match(PINNED_DISPATCH_RULES, /never as a foreign\s+claim/);
  assert.match(PINNED_DISPATCH_RULES, /opened by someone else, exit\s+immediately/);
  for (const mirror of MIRROR_PATHS)
    assert.equal(readFileSync(mirror, "utf8"), PINNED_DISPATCH_RULES, "setup.sh mirror matches canonical skill");
  const parity = spawnSync("node", ["scripts/skill-parity.mjs"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(parity.status, 0, `${parity.stdout}\n${parity.stderr}`);
}

// --- Issue #430 Criterion 2: the shipped default prompt is short, names the
// issue, and delegates the complete pinned contract to the canonical skill ---
{
  const prompts = Object.values(defaultConfig().adapters).map(({ promptTemplate }) => promptTemplate);
  assert.ok(prompts.length >= 2, "the shipped default retains both adapters");
  assert.ok(prompts.every((prompt) => prompt === prompts[0]), "all shipped adapters share one prompt");
  assert.equal(
    prompts[0],
    "Issue {issue} is your entire assignment. Read `.agents/skills/ratchet-herd/SKILL.md` for the pinned worker dispatch rules, then follow them and AGENTS.md.",
  );
  assert.ok(prompts[0].length < 220, "the default prompt is materially shorter than the inline contract");
}

// --- Issue #430 Criterion 3: a rendered worker prompt contains the dispatched
// issue number and the canonical skill path ----------------------------------
{
  const plan = buildDispatch(defaultConfig(), { number: 430, labels: [] });
  const rendered = plan.argv.at(-1);
  assert.match(rendered, /Issue 430 is your entire assignment/);
  assert.match(rendered, /\.agents\/skills\/ratchet-herd\/SKILL\.md/);
  assert.doesNotMatch(rendered, /\{issue\}/);
}

// --- Issue #430 Criterion 4: DOCS.md mirrors the default verbatim, preserves
// the operator migration note, and documents the prompt-cache rationale ------
{
  const docs = readFileSync(fileURLToPath(new URL("../DOCS.md", import.meta.url)), "utf8");
  for (const adapter of Object.values(defaultConfig().adapters))
    assert.ok(docs.includes(`"promptTemplate": ${JSON.stringify(adapter.promptTemplate)}`), "DOCS.md matches the default prompt");
  assert.match(docs, /update the `promptTemplate` in yours by hand/);
  assert.match(docs, /shared prompt prefix short and dispatch instructions tight/);
  assert.match(docs, /improves prompt-cache hit rate/);
}

// --- Issue #430 Criterion 5: this suite has exactly one test named after each
// issue-430 criterion --------------------------------------------------------
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...self.matchAll(/^\/\/ --- Issue #430 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  assert.deepEqual(markers, [1, 2, 3, 4, 5], "each issue-430 criterion has exactly one named test");
}

console.log("herd-submit-contract.test.mjs: all criteria passed");

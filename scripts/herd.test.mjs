#!/usr/bin/env node
// herd.test.mjs — the criteria are the test plan. One test per acceptance
// criterion of issue #103 (herd config loader, validation, init), exercised
// through herd.mjs's public interface. Fully offline — no network, no spawned
// CLIs, only the local filesystem in a throwaway temp dir.
// Zero dependencies. Run:  node scripts/herd.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, loadConfig, normalizeConfig, substitute, resolveAdapter, defaultConfig, HerdConfigError, DEFAULTS } from "./herd.mjs";

// Run `fn` with cwd set to a fresh temp dir, then clean up — lets CLI-level
// tests exercise the cwd-relative default config path without side effects.
function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-"));
  const cwd = process.cwd();
  try {
    return process.chdir(dir), fn(dir);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Capture a `main()` call's exit code and its console output.
function capture(fn) {
  const orig = { log: console.log, error: console.error };
  const out = [];
  const err = [];
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    return { code: fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}

// Criterion 1: `init` writes a default .ratchet/herd.json with claude and codex
// adapters, and refuses to overwrite an existing file with a clear message.
inTempDir(() => {
  const first = capture(() => main(["init"]));
  assert.equal(first.code, 0, "init succeeds on a fresh repo");
  assert.ok(existsSync(".ratchet/herd.json"), "init writes .ratchet/herd.json");
  const written = JSON.parse(readFileSync(".ratchet/herd.json", "utf8"));
  assert.ok(written.adapters.claude, "default config has a claude adapter");
  assert.ok(written.adapters.codex, "default config has a codex adapter");

  const second = capture(() => main(["init"]));
  assert.equal(second.code, 1, "a second init must not overwrite");
  assert.match(second.err, /already exists|overwrite/i, "refusal message is clear");
});

// Criterion 2: running the supervisor with no .ratchet/herd.json exits non-zero
// with a one-line hint to run the init step.
inTempDir(() => {
  const r = capture(() => main(["run"]));
  assert.equal(r.code, 1, "no config -> non-zero exit");
  assert.match(r.err, /init/, "the hint names the init step");
  assert.ok(!r.err.includes("\n"), "the hint is a single line");
});

// Criterion 3: malformed JSON, empty adapters, or routing without a default
// each exit non-zero with a one-line error naming the file and the problem.
inTempDir(() => {
  const p = "cfg.json";
  writeFileSync(p, "{ not json");
  assert.throws(
    () => loadConfig(p),
    (e) => e instanceof HerdConfigError && e.message.includes(p) && /json/i.test(e.message),
    "malformed JSON is rejected, naming the file",
  );
  writeFileSync(p, JSON.stringify({ adapters: {}, routing: { default: "x" } }));
  assert.throws(
    () => loadConfig(p),
    (e) => e.message.includes(p) && /adapter/i.test(e.message),
    "empty adapters is rejected, naming the file",
  );
  writeFileSync(p, JSON.stringify({ adapters: { a: { launch: ["a"] } }, routing: {} }));
  assert.throws(
    () => loadConfig(p),
    (e) => e.message.includes(p) && /default/i.test(e.message),
    "routing without a default is rejected, naming the file",
  );
});

// Criterion 4: omitted optional fields default to maxWorkers:3, pollSeconds:60,
// reworkCap:2, logDir:".ratchet/logs".
{
  const cfg = normalizeConfig({ adapters: { a: { launch: ["a"] } }, routing: { default: "a" } });
  assert.deepEqual(
    { m: cfg.maxWorkers, p: cfg.pollSeconds, r: cfg.reworkCap, l: cfg.logDir },
    { m: 3, p: 60, r: 2, l: ".ratchet/logs" },
    "omitted fields fall back to the documented defaults",
  );
  assert.deepEqual(
    { m: cfg.maxWorkers, p: cfg.pollSeconds, r: cfg.reworkCap, l: cfg.logDir },
    { m: DEFAULTS.maxWorkers, p: DEFAULTS.pollSeconds, r: DEFAULTS.reworkCap, l: DEFAULTS.logDir },
    "defaults come from the single DEFAULTS source",
  );
}

// Criterion 5: {prompt} and {issue} are the only placeholders substituted in
// adapter command arrays and prompt templates; any other brace token passes
// through verbatim.
{
  assert.equal(substitute("do {issue} now", { issue: 42 }), "do 42 now");
  assert.deepEqual(
    substitute(["run", "{prompt}", "--issue", "{issue}"], { prompt: "hi", issue: 7 }),
    ["run", "hi", "--issue", "7"],
    "both placeholders substitute inside a command array",
  );
  assert.equal(
    substitute("keep {other} and {model} literal", { prompt: "p", issue: "1" }),
    "keep {other} and {model} literal",
    "unknown brace tokens pass through verbatim",
  );
}

// Criterion 6: routing resolves an issue's adapter by first matching label,
// falling back to the default entry.
{
  const cfg = normalizeConfig({
    adapters: { a: { launch: ["a"] }, b: { launch: ["b"] } },
    routing: { default: "a", labels: { hard: "b" } },
  });
  assert.equal(resolveAdapter(cfg, ["hard"]).name, "b", "a matching label routes to its adapter");
  assert.equal(resolveAdapter(cfg, ["misc"]).name, "a", "no match falls back to the default");
  assert.equal(resolveAdapter(cfg, []).name, "a", "no labels falls back to the default");
  assert.equal(resolveAdapter(cfg, ["misc", "hard"]).name, "b", "the first matching label wins");
}

// Criterion 7: an adapter without a resume command resolves its resume command
// to its launch command.
{
  const cfg = normalizeConfig({ adapters: { a: { launch: ["cli", "{prompt}"] } }, routing: { default: "a" } });
  assert.deepEqual(cfg.adapters.a.resume, ["cli", "{prompt}"], "resume defaults to launch");
  const cfg2 = normalizeConfig({
    adapters: { a: { launch: ["x"], resume: ["x", "--continue"] } },
    routing: { default: "a" },
  });
  assert.deepEqual(cfg2.adapters.a.resume, ["x", "--continue"], "an explicit resume is kept");
}

// Criterion 8: a purity test greps herd.mjs and fails on any reference to
// specific proxies, terminal multiplexers, or model names — those belong in
// .ratchet/herd.json, never in the framework code.
{
  const src = readFileSync(new URL("./herd.mjs", import.meta.url), "utf8");
  const BANNED = [
    "tmux", "zellij", "wezterm", "\\bscreen\\b", // terminal multiplexers
    "opus", "sonnet", "haiku", "gpt-3", "gpt-4", "gpt-5", "davinci", "gemini", "llama", "mistral", // models
    "litellm", "openrouter", "rtk", // proxies / gateways
  ];
  for (const token of BANNED)
    assert.ok(!new RegExp(token, "i").test(src), `herd.mjs must stay framework-pure: it references "${token}"`);
}

// Criterion 9: herd.test.mjs passes offline with plain node (this run proves
// it), and GATES.md lists it so run-gates executes it and gates-coverage can't
// flag it as an orphan suite.
{
  const gates = readFileSync(new URL("../GATES.md", import.meta.url), "utf8");
  assert.match(gates, /node scripts\/herd\.test\.mjs/, "GATES.md must list herd.test.mjs as a gate");
}

// Criterion 10 (issue #126): claimTimeoutSeconds is an optional knob defaulting
// to minutes (not 60s), long enough for an agent CLI to reach the claim step; a
// non-positive or non-integer value exits non-zero with a one-line error naming
// the file and the field.
{
  const base = { adapters: { a: { launch: ["a"] } }, routing: { default: "a" } };
  const cfg = normalizeConfig(base);
  assert.equal(cfg.claimTimeoutSeconds, DEFAULTS.claimTimeoutSeconds, "omitted claimTimeoutSeconds takes the default");
  assert.ok(cfg.claimTimeoutSeconds >= 120, "the default is minutes, not the old 60s wall");

  assert.equal(
    normalizeConfig({ ...base, claimTimeoutSeconds: 90 }).claimTimeoutSeconds,
    90,
    "an explicit claimTimeoutSeconds is kept",
  );

  for (const bad of [0, -5, 1.5]) {
    assert.throws(
      () => normalizeConfig({ ...base, claimTimeoutSeconds: bad }, "cfg.json"),
      (e) =>
        e instanceof HerdConfigError &&
        e.message.includes("cfg.json") &&
        /claimTimeoutSeconds/.test(e.message) &&
        !e.message.includes("\n"),
      `claimTimeoutSeconds=${bad} is rejected, naming the file and field on one line`,
    );
  }
}

// ── Issue #132: pin the herd worker prompt to its dispatched issue ──
// The default promptTemplate is data in herd.json; defaultConfig() is its
// single source of truth. Every criterion below is asserted against the string
// defaultConfig() writes, for both shipped adapters.
const promptTemplates = () => {
  const { adapters } = defaultConfig();
  return Object.entries(adapters).map(([name, a]) => [name, a.promptTemplate]);
};

// Criterion 11 (#132 AC1): the default promptTemplate tells the worker issue
// {issue} is its entire assignment — skip AGENTS.md's pick step and never
// claim, work on, or fall through to any other issue.
{
  for (const [name, t] of promptTemplates()) {
    assert.match(t, /\{issue\} is your entire assignment/i, `${name}: names {issue} as the whole assignment`);
    assert.match(t, /skip AGENTS\.md's pick step/i, `${name}: tells the worker to skip AGENTS.md's pick step`);
    assert.match(
      t,
      /never claim, work on, or fall\s+through to any other issue/i,
      `${name}: forbids claiming/working/falling through to another issue`,
    );
  }
}

// Criterion 12 (#132 AC2): the template treats an existing agent/issue-{issue}
// branch as this same assignment — resume it per AGENTS.md's resume rules —
// never as a foreign claim that triggers exit or fall-through.
{
  for (const [name, t] of promptTemplates()) {
    assert.match(t, /agent\/issue-\{issue\} branch is your own prior claim/i, `${name}: the branch is the worker's own claim`);
    assert.match(t, /resume it under AGENTS\.md's resume rules/i, `${name}: resume per AGENTS.md, not re-claim`);
    assert.match(t, /never as a foreign claim/i, `${name}: the branch is not treated as foreign`);
  }
}

// Criterion 13 (#132 AC3): a worker whose issue already has a PR opened by
// someone else is told to exit without touching any branch, worktree, or issue.
{
  for (const [name, t] of promptTemplates()) {
    assert.match(
      t,
      /pull request opened by someone else, exit immediately/i,
      `${name}: a foreign PR means exit immediately`,
    );
    assert.match(
      t,
      /without touching any branch, worktree, or other issue/i,
      `${name}: exit touches nothing`,
    );
  }
}

// Criterion 14 (#132 AC4): the promptTemplate examples in DOCS.md match the new
// default verbatim — both shipped adapters carry the exact string, and the old
// "Pick up issue" default is gone from the docs.
{
  const docs = readFileSync(new URL("../DOCS.md", import.meta.url), "utf8");
  const templates = promptTemplates().map(([, t]) => t);
  for (const t of templates)
    assert.ok(docs.includes(`"promptTemplate": ${JSON.stringify(t)}`), "DOCS.md shows the default promptTemplate verbatim");
  assert.equal(
    (docs.match(/"promptTemplate": "Issue \{issue\} is your entire assignment/g) || []).length,
    templates.length,
    "DOCS.md carries one verbatim example per shipped adapter",
  );
  assert.ok(!docs.includes("Pick up issue {issue} and take it to a PR"), "the old promptTemplate default is gone from DOCS.md");
}

// Criterion 15 (#132 AC5): every #132 criterion above has exactly one test
// named after it — this file declares criteria 11–14 once each, no padding.
{
  const self = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4"]) {
    const hits = (self.match(new RegExp(`#132 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#132 ${ac} has exactly one test named after it`);
  }
}

// Criterion 16 (#139 AC1): logRetentionDays is an optional knob with a sensible
// default; a non-positive or non-integer value exits non-zero with a one-line
// error naming the file and the field.
{
  const base = { adapters: { a: { launch: ["a"] } }, routing: { default: "a" } };
  const cfg = normalizeConfig(base);
  assert.equal(cfg.logRetentionDays, DEFAULTS.logRetentionDays, "omitted logRetentionDays takes the default");
  assert.ok(
    Number.isInteger(cfg.logRetentionDays) && cfg.logRetentionDays > 0,
    "the default is a sensible positive integer of days",
  );

  assert.equal(
    normalizeConfig({ ...base, logRetentionDays: 30 }).logRetentionDays,
    30,
    "an explicit logRetentionDays is kept",
  );

  for (const bad of [0, -5, 1.5]) {
    assert.throws(
      () => normalizeConfig({ ...base, logRetentionDays: bad }, "cfg.json"),
      (e) =>
        e instanceof HerdConfigError &&
        e.message.includes("cfg.json") &&
        /logRetentionDays/.test(e.message) &&
        !e.message.includes("\n"),
      `logRetentionDays=${bad} rejected, naming file and field on one line`,
    );
  }
}

console.log("PASS herd.test.mjs (16 criteria)");

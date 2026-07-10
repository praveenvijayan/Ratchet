#!/usr/bin/env node
// herd.test.mjs — the criteria are the test plan. One test per acceptance
// criterion of issue #103 (herd config loader, validation, init), exercised
// through herd.mjs's public interface. Fully offline — no network, no spawned
// CLIs, only the local filesystem in a throwaway temp dir.
// Zero dependencies. Run:  node scripts/herd.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, loadConfig, normalizeConfig, substitute, resolveAdapter, adapterAvailability, executableOnPath, defaultConfig, headlessFlagWarnings, HEADLESS_PERMISSION_FLAGS, HerdConfigError, DEFAULTS, extractUsage, USAGE_FIELDS, CONFIG_PATH } from "./herd.mjs";
import { resolveRepoRoot, ratchetPaths, RepoRootError } from "./herd-survey.mjs";

// Run `fn` with cwd set to a fresh temp dir, then clean up — lets CLI-level
// tests exercise the cwd-relative default config path without side effects.
function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-"));
  // `main` anchors the config at the repo root (nearest `.git`); mark this temp
  // dir as a checkout so it resolves to itself, exercising the cwd-relative
  // default config path without escaping to the real repo.
  mkdirSync(join(dir, ".git"));
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
  const up = { onPath: () => true }; // both adapters available — this test is about routing, not availability
  assert.equal(resolveAdapter(cfg, ["hard"], up).name, "b", "a matching label routes to its adapter");
  assert.equal(resolveAdapter(cfg, ["misc"], up).name, "a", "no match falls back to the default");
  assert.equal(resolveAdapter(cfg, [], up).name, "a", "no labels falls back to the default");
  assert.equal(resolveAdapter(cfg, ["misc", "hard"], up).name, "b", "the first matching label wins");
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

// Criterion 17 (#149 AC1): `init` writes a claude adapter whose launch carries
// --dangerously-skip-permissions, so a headless claude worker can claim.
inTempDir(() => {
  capture(() => main(["init"]));
  const written = JSON.parse(readFileSync(".ratchet/herd.json", "utf8"));
  assert.ok(
    written.adapters.claude.launch.includes("--dangerously-skip-permissions"),
    "init's claude launch carries --dangerously-skip-permissions",
  );
});

// Criterion 18 (#149 AC2): `init` writes a codex adapter whose launch carries
// codex's documented non-interactive approval-bypass flag.
inTempDir(() => {
  capture(() => main(["init"]));
  const written = JSON.parse(readFileSync(".ratchet/herd.json", "utf8"));
  assert.ok(
    written.adapters.codex.launch.includes("--dangerously-bypass-approvals-and-sandbox"),
    "init's codex launch carries --dangerously-bypass-approvals-and-sandbox",
  );
});

// Criterion 19 (#149 AC3): loading a config whose claude/codex launch omits its
// headless-permission flag prints a one-line WARNING naming the adapter and the
// missing flag, and continues (returns the normalized config, exit zero).
inTempDir(() => {
  const p = "cfg.json";
  writeFileSync(
    p,
    JSON.stringify({ adapters: { claude: { launch: ["claude", "-p", "{prompt}"] } }, routing: { default: "claude" } }),
  );
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let cfg;
  try {
    cfg = loadConfig(p);
  } finally {
    console.warn = orig;
  }
  assert.ok(cfg && cfg.adapters.claude, "load continues and returns the normalized config (exit zero)");
  assert.equal(warns.length, 1, "exactly one warning for the one offending adapter");
  assert.match(warns[0], /^WARNING/, "the line is a WARNING");
  assert.match(warns[0], /claude/, "the warning names the adapter");
  assert.match(warns[0], /--dangerously-skip-permissions/, "the warning names the missing flag");
  assert.ok(!warns[0].includes("\n"), "the warning is a single line");
});

// Criterion 20 (#149 AC4): the warning is silent for any adapter that is not
// claude or codex, and for a claude/codex adapter whose launch already carries
// its flag (including the shipped init default).
{
  const other = normalizeConfig({ adapters: { myagent: { launch: ["myagent", "run"] } }, routing: { default: "myagent" } });
  assert.deepEqual(headlessFlagWarnings(other), [], "a non-claude/codex adapter is never warned");

  const armed = normalizeConfig({
    adapters: {
      claude: { launch: ["claude", "-p", HEADLESS_PERMISSION_FLAGS.claude, "{prompt}"] },
      codex: { launch: ["codex", "exec", HEADLESS_PERMISSION_FLAGS.codex, "{prompt}"] },
    },
    routing: { default: "claude" },
  });
  assert.deepEqual(headlessFlagWarnings(armed), [], "a shipped adapter already carrying its flag is silent");
  assert.deepEqual(headlessFlagWarnings(normalizeConfig(defaultConfig())), [], "the init default carries both flags, so it is silent");
}

// Criterion 21 (#149 AC5): each #149 criterion above has exactly one test named
// after it — no missing coverage, no padding.
{
  const self = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4"]) {
    const hits = (self.match(new RegExp(`#149 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#149 ${ac} has exactly one test named after it`);
  }
}

// Criterion 22 (#151 AC1): a routing entry (default or a labels value) may be an
// adapter name or a non-empty ordered array of names; a name that is not a
// defined adapter exits non-zero naming the offending entry and the bad name.
{
  const ok = normalizeConfig({
    adapters: { a: { launch: ["a"] }, b: { launch: ["b"] } },
    routing: { default: ["a", "b"], labels: { hard: "b" } },
  });
  assert.deepEqual(ok.routing.default, ["a", "b"], "an array default is kept as an ordered list");
  assert.deepEqual(ok.routing.labels.hard, ["b"], "a string label route is normalized to a one-element list");

  assert.throws(
    () => normalizeConfig({ adapters: { a: { launch: ["a"] } }, routing: { default: ["a", "ghost"] } }, "cfg.json"),
    (e) => e.message.includes("cfg.json") && /routing\.default/.test(e.message) && /ghost/.test(e.message),
    "an undefined adapter in a default array is rejected, naming the entry and the name",
  );
  assert.throws(
    () => normalizeConfig({ adapters: { a: { launch: ["a"] } }, routing: { default: "a", labels: { hard: ["a", "ghost"] } } }, "cfg.json"),
    (e) => e.message.includes(`routing.labels["hard"]`) && /ghost/.test(e.message),
    "an undefined adapter in a label array is rejected, naming the entry and the name",
  );
  assert.throws(
    () => normalizeConfig({ adapters: { a: { launch: ["a"] } }, routing: { default: [] } }, "cfg.json"),
    (e) => /routing\.default/.test(e.message) && /empty/.test(e.message),
    "an empty route list is rejected",
  );
}

// Criterion 23 (#151 AC2): an adapter may declare requiresEnv; it is unavailable
// when its launch binary does not resolve on PATH, or when any requiresEnv var
// is unset or empty — the reason distinguishes the two.
{
  const cfg = normalizeConfig({
    adapters: { a: { launch: ["a"], requiresEnv: ["TOKEN"] } },
    routing: { default: "a" },
  });
  assert.deepEqual(cfg.adapters.a.requiresEnv, ["TOKEN"], "requiresEnv is normalized onto the adapter");

  const gone = adapterAvailability(cfg.adapters.a, { env: { TOKEN: "x" }, onPath: () => false });
  assert.equal(gone.available, false, "a launch binary not on PATH makes the adapter unavailable");
  assert.match(gone.reason, /binary .*not found on PATH/, "the reason names the missing binary");

  const unset = adapterAvailability(cfg.adapters.a, { env: {}, onPath: () => true });
  assert.equal(unset.available, false, "an unset required env var makes the adapter unavailable");
  assert.match(unset.reason, /TOKEN is unset or empty/, "the reason names the unset env var");
  assert.equal(adapterAvailability(cfg.adapters.a, { env: { TOKEN: "" }, onPath: () => true }).available, false, "an empty required env var is also unavailable");

  assert.equal(adapterAvailability(cfg.adapters.a, { env: { TOKEN: "x" }, onPath: () => true }).available, true, "binary present and every requiresEnv set → available");

  assert.throws(
    () => normalizeConfig({ adapters: { a: { launch: ["a"], requiresEnv: ["", 5] } }, routing: { default: "a" } }, "cfg.json"),
    (e) => e.message.includes("cfg.json") && /requiresEnv/.test(e.message),
    "a malformed requiresEnv is rejected, naming the file",
  );
}

// Criterion 24 (#151 AC3): resolveAdapter returns the first available adapter in
// the resolved route; a string entry behaves as a one-element list, so a config
// whose preferred binary is present dispatches unchanged.
{
  const cfg = normalizeConfig({
    adapters: {
      a: { launch: ["a"], requiresEnv: ["A_KEY"] },
      b: { launch: ["b"] },
      c: { launch: ["c"] },
    },
    routing: { default: ["a", "b", "c"], labels: {} },
  });
  // a is skipped (A_KEY unset), b wins.
  const r = resolveAdapter(cfg, [], { env: {}, onPath: () => true });
  assert.equal(r.name, "b", "the first available adapter in the route wins, skipping the unavailable one");
  assert.deepEqual(r.tried.map((t) => t.name), ["a"], "the skipped adapter is recorded with its reason");

  // a becomes available once its key is set → the preferred adapter dispatches.
  assert.equal(resolveAdapter(cfg, [], { env: { A_KEY: "x" }, onPath: () => true }).name, "a", "the preferred adapter wins once available");

  // A string route with a present binary resolves exactly as a one-element list.
  const one = normalizeConfig({ adapters: { a: { launch: ["a"] } }, routing: { default: "a" } });
  assert.equal(resolveAdapter(one, [], { onPath: () => true }).name, "a", "a string route with a present binary dispatches unchanged");
}

// Criterion 25 (#151 AC5): the availability and fallback logic in herd.mjs names
// no specific CLI, model, or env-var — it stays framework-pure. The whole module
// is greppable; the new functions add no exception.
{
  const src = readFileSync(new URL("./herd.mjs", import.meta.url), "utf8");
  const BANNED = [
    "tmux", "zellij", "wezterm", "\\bscreen\\b",
    "opus", "sonnet", "haiku", "gpt-3", "gpt-4", "gpt-5", "davinci", "gemini", "llama", "mistral",
    "litellm", "openrouter", "rtk",
    // No adapter-specific env-var name may be baked into the availability check.
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  ];
  for (const token of BANNED)
    assert.ok(!new RegExp(token, "i").test(src), `herd.mjs must stay framework-pure: it references "${token}"`);
  // Availability keys off config-supplied names only — requiresEnv is read, never
  // a literal variable name.
  assert.match(src, /requiresEnv/, "availability reads requiresEnv from config, not a hardcoded var name");
}

// Criterion 26 (#151 AC6): each #151 criterion has exactly one test named after
// it, counted across both herd.test.mjs and herd-dispatch.test.mjs (AC4 lives in
// the dispatch suite).
{
  const here = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  const dispatch = readFileSync(new URL("./herd-dispatch.test.mjs", import.meta.url), "utf8");
  const both = here + "\n" + dispatch;
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5"]) {
    const hits = (both.match(new RegExp(`#151 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#151 ${ac} has exactly one test named after it`);
  }
}

// ── Issue #155: let a herd adapter pin a model so different models dispatch ──
// {model} is a config-substitution placeholder in the same family as {prompt}
// and {issue}; an adapter names the model in config and the loader stays pure.

// Criterion 32 (#155 AC1): an adapter may declare a `model`; {model} in its
// launch argv and promptTemplate is substituted exactly as {prompt}/{issue},
// and every other brace token still passes through verbatim.
{
  const cfg = normalizeConfig({
    adapters: {
      a: {
        launch: ["cli", "--model", "{model}", "{prompt}"],
        promptTemplate: "use {model} on issue {issue}",
        model: "some-model-x",
      },
    },
    routing: { default: "a" },
  });
  const { adapter } = resolveAdapter(cfg, [], { onPath: () => true });
  assert.equal(adapter.model, "some-model-x", "the declared model normalizes onto the adapter");
  assert.deepEqual(
    substitute(adapter.launch, { prompt: "hi", issue: 7, model: adapter.model }),
    ["cli", "--model", "some-model-x", "hi"],
    "{model} substitutes in the launch argv exactly like {prompt}/{issue}",
  );
  assert.equal(
    substitute(adapter.promptTemplate, { issue: 7, model: adapter.model }),
    "use some-model-x on issue 7",
    "{model} substitutes in the promptTemplate too",
  );
  assert.equal(
    substitute("keep {other} literal, pin {model}", { model: "some-model-x" }),
    "keep {other} literal, pin some-model-x",
    "every other brace token still passes through verbatim while {model} substitutes",
  );
}

// Criterion 28 (#155 AC2): an adapter whose launch or promptTemplate uses
// {model} but declares no `model` exits nonzero with a one-line error naming
// the adapter and the missing field.
{
  for (const bad of [
    { adapters: { a: { launch: ["cli", "{model}"] } }, routing: { default: "a" } },
    { adapters: { a: { launch: ["cli"], promptTemplate: "run on {model}" } }, routing: { default: "a" } },
  ]) {
    assert.throws(
      () => normalizeConfig(bad, "cfg.json"),
      (e) =>
        e instanceof HerdConfigError &&
        e.message.includes("cfg.json") &&
        /"a"/.test(e.message) &&
        /model/.test(e.message) &&
        !e.message.includes("\n"),
      "a {model} adapter with no model field is rejected on one line naming the adapter and field",
    );
  }
  // And the loader turns that into a nonzero process exit.
  inTempDir(() => {
    mkdirSync(".ratchet", { recursive: true });
    writeFileSync(
      ".ratchet/herd.json",
      JSON.stringify({ adapters: { a: { launch: ["cli", "{model}"] } }, routing: { default: "a" } }),
    );
    const r = capture(() => main(["run"]));
    assert.equal(r.code, 1, "a {model} adapter with no model exits nonzero");
    assert.ok(!r.err.includes("\n"), "the error is a single line");
  });
}

// Criterion 29 (#155 AC3): two adapters that differ only by `model` both
// validate and are independently routable and dispatchable.
{
  const cfg = normalizeConfig({
    adapters: {
      fast: { launch: ["orcli", "--model", "{model}", "{prompt}"], model: "model-fast" },
      slow: { launch: ["orcli", "--model", "{model}", "{prompt}"], model: "model-slow" },
    },
    routing: { default: "fast", labels: { heavy: "slow" } },
  });
  assert.equal(resolveAdapter(cfg, ["heavy"], { onPath: () => true }).name, "slow", "a label routes to the slow-model adapter");
  assert.equal(resolveAdapter(cfg, [], { onPath: () => true }).name, "fast", "the default routes to the fast-model adapter");
  const argv = (name) =>
    substitute(cfg.adapters[name].launch, { prompt: "p", issue: 1, model: cfg.adapters[name].model });
  assert.deepEqual(argv("fast"), ["orcli", "--model", "model-fast", "p"], "the fast adapter dispatches on its model");
  assert.deepEqual(argv("slow"), ["orcli", "--model", "model-slow", "p"], "the slow adapter dispatches on its model");
  assert.notDeepEqual(argv("fast"), argv("slow"), "adapters differing only by model dispatch distinct commands");
}

// Criterion 30 (#155 AC4): `model` is optional — an adapter that neither
// declares `model` nor uses {model} loads and dispatches exactly as before.
{
  const cfg = normalizeConfig({ adapters: { a: { launch: ["cli", "{prompt}", "{issue}"] } }, routing: { default: "a" } });
  assert.ok(!("model" in cfg.adapters.a), "a model-free adapter carries no model field (unchanged shape)");
  assert.deepEqual(
    substitute(cfg.adapters.a.launch, { prompt: "hi", issue: 9, model: cfg.adapters.a.model }),
    ["cli", "hi", "9"],
    "a model-free adapter dispatches exactly as before — undefined model is harmless",
  );
  const shipped = normalizeConfig(defaultConfig());
  assert.ok(!("model" in shipped.adapters.claude) && !("model" in shipped.adapters.codex), "the shipped default is model-free and still loads");
}

// Criterion 31 (#155 AC5): the framework purity test still passes — no specific
// model name appears in scripts/herd.mjs; the model lives only in config.
{
  const src = readFileSync(new URL("./herd.mjs", import.meta.url), "utf8");
  for (const token of ["opus", "sonnet", "haiku", "gpt-3", "gpt-4", "gpt-5", "davinci", "gemini", "llama", "mistral"])
    assert.ok(!new RegExp(token, "i").test(src), `herd.mjs names no model ("${token}") — models live only in config`);
  const { adapters } = defaultConfig();
  for (const [name, a] of Object.entries(adapters))
    assert.ok(!("model" in a), `shipped adapter "${name}" declares no model — the operator names it in config`);
}

// Criterion 32 (#155 AC6): each #155 criterion above has exactly one test named
// after it — no missing coverage, no padding.
{
  const self = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5"]) {
    const hits = (self.match(new RegExp(`#155 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#155 ${ac} has exactly one test named after it`);
  }
}

// ── Issue #152: document an opencode/OpenRouter fallback adapter ──────────────
// opencode is pure config, like every herd adapter. These tests exercise the
// documented claude→codex→opencode route against a *real* stub opencode binary,
// so availability — not a mock — decides dispatch.

// The documented opencode adapter plus the claude→codex→opencode chain, as one
// normalized config.
const opencodeDocConfig = () =>
  normalizeConfig({
    adapters: {
      claude: { launch: ["claude", "-p", HEADLESS_PERMISSION_FLAGS.claude, "{prompt}"], promptTemplate: "p" },
      codex: { launch: ["codex", "exec", HEADLESS_PERMISSION_FLAGS.codex, "{prompt}"], promptTemplate: "p" },
      opencode: {
        launch: ["opencode", "run", "--model", "openrouter/{model}", "{prompt}"],
        model: "anthropic/claude-3.5-sonnet",
        requiresEnv: ["OPENROUTER_API_KEY"],
        promptTemplate: "p",
      },
    },
    routing: { default: ["claude", "codex", "opencode"] },
  });

// Run `fn(binDir)` with a throwaway dir holding an executable `opencode` stub and
// nothing else — so PATH=binDir means opencode resolves while claude/codex do not.
function withStubOpencode(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-bin-"));
  try {
    const exe = join(dir, "opencode");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Criterion 33 (#152 AC1): DOCS.md carries a copy-ready opencode adapter block —
// opencode run headless against OpenRouter, requiresEnv ["OPENROUTER_API_KEY"] —
// alongside a routing.default chain claude → codex → opencode.
{
  const docs = readFileSync(new URL("../DOCS.md", import.meta.url), "utf8");
  assert.ok(docs.includes('"opencode": {'), "DOCS.md defines an opencode adapter block");
  assert.ok(docs.includes('"opencode", "run"'), "the opencode launch uses opencode's headless run subcommand");
  assert.ok(docs.includes('"requiresEnv": ["OPENROUTER_API_KEY"]'), "the opencode adapter gates on OPENROUTER_API_KEY via requiresEnv");
  assert.ok(docs.includes('"default": ["claude", "codex", "opencode"]'), "DOCS.md shows the claude → codex → opencode routing.default chain");
}

// Criterion 34 (#152 AC2): DOCS.md calls out that the opencode launch runs fully
// non-interactive — it never blocks on an approval/permission prompt for
// git/shell/filesystem actions (the headless-claim failure mode).
{
  const docs = readFileSync(new URL("../DOCS.md", import.meta.url), "utf8");
  assert.ok(docs.includes("opencode must run fully non-interactive"), "the docs call the opencode launch fully non-interactive");
  assert.ok(docs.includes("without\npausing for a permission or approval prompt") || docs.includes("without pausing for a permission or approval prompt"), "the docs say it never pauses for a permission or approval prompt");
  assert.ok(docs.includes("the headless-claim failure mode"), "the docs tie a blocking prompt to the headless-claim failure mode");
}

// Criterion 35 (#152 AC3): with OPENROUTER_API_KEY unset, the claude→codex→
// opencode route treats opencode as unavailable and dispatches no opencode
// worker — verified against a real stub opencode binary on PATH.
withStubOpencode((binDir) => {
  const cfg = opencodeDocConfig();
  // Only the stub opencode is on PATH (claude/codex absent) and the key is unset.
  const r = resolveAdapter(cfg, [], { env: { PATH: binDir }, onPath: executableOnPath });
  assert.notEqual(r.name, "opencode", "no opencode worker is dispatched while OPENROUTER_API_KEY is unset");
  assert.equal(r.name, null, "no adapter in the route is available, so nothing is dispatched");
  assert.ok(
    r.tried.some((t) => t.name === "opencode" && /OPENROUTER_API_KEY/.test(t.reason)),
    "opencode is recorded unavailable because its required key is unset",
  );
});

// Criterion 36 (#152 AC4): with claude and codex absent from PATH and
// OPENROUTER_API_KEY set, the same route dispatches the opencode worker.
withStubOpencode((binDir) => {
  const cfg = opencodeDocConfig();
  const r = resolveAdapter(cfg, [], { env: { PATH: binDir, OPENROUTER_API_KEY: "sk-test" }, onPath: executableOnPath });
  assert.equal(r.name, "opencode", "opencode wins once claude/codex are off PATH and its key is set");
  assert.deepEqual(r.tried.map((t) => t.name), ["claude", "codex"], "claude and codex were tried and skipped as unavailable");
});

// Criterion 37 (#152 AC5): the framework stays pure — scripts/herd.mjs names
// neither "opencode" nor "openrouter"; they appear only in config and docs.
{
  const src = readFileSync(new URL("./herd.mjs", import.meta.url), "utf8");
  for (const token of ["opencode", "openrouter"])
    assert.ok(!new RegExp(token, "i").test(src), `herd.mjs must stay framework-pure: it names "${token}"`);
}

// Criterion 38 (#152 AC6): each #152 criterion above has exactly one test named
// after it — no missing coverage, no padding.
{
  const self = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5"]) {
    const hits = (self.match(new RegExp(`#152 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#152 ${ac} has exactly one test named after it`);
  }
}

// ── Issue #156: distribute herd dispatch across adapters (round-robin) ──
// A route may opt into a round-robin policy so successive workers spread across
// the available adapters instead of always piling onto the first. The default
// stays failover, so existing configs are byte-for-byte unchanged in behaviour.

// Criterion 39 (#156 AC1): a route may declare its selection policy; with none
// declared the policy stays "failover" (first available, unchanged), so existing
// configs behave identically — no rotation.
{
  const cfg = normalizeConfig({
    adapters: { a: { launch: ["a"], requiresEnv: ["A_KEY"] }, b: { launch: ["b"] } },
    routing: { default: ["a", "b"], labels: {} },
  });
  assert.equal(cfg.routing.policies["routing.default"], "failover", "a route with no declared policy defaults to failover");
  assert.equal(
    resolveAdapter(cfg, [], { env: {}, onPath: () => true }).name,
    "b",
    "failover skips the unavailable preferred adapter and takes the first available — unchanged from before",
  );
  // Failover never rotates: the same first-available adapter wins every call
  // regardless of a stale cursor, so an existing config dispatches identically.
  assert.equal(
    resolveAdapter(cfg, [], { env: { A_KEY: "x" }, onPath: () => true, cursors: { "routing.default": 1 } }).name,
    "a",
    "failover always returns the first available adapter, ignoring any rotation cursor",
  );
}

// Criterion 41 (#156 AC3): round-robin skips adapters that are unavailable (per
// the availability check) and never blocks on them — with the middle adapter
// down, the rotation cycles only the two available ones.
{
  const cfg = normalizeConfig({
    adapters: { a: { launch: ["a"] }, b: { launch: ["b"], requiresEnv: ["B_KEY"] }, c: { launch: ["c"] } },
    routing: { default: { adapters: ["a", "b", "c"], policy: "round-robin" }, labels: {} },
  });
  const cursors = {};
  const picks = [];
  for (let i = 0; i < 4; i++) {
    const r = resolveAdapter(cfg, [], { env: {}, onPath: () => true, cursors }); // B_KEY unset -> b unavailable
    picks.push(r.name);
    cursors[r.cursorKey] = r.nextCursor;
  }
  assert.deepEqual(picks, ["a", "c", "a", "c"], "round-robin skips the unavailable adapter every round and cycles the rest");
  assert.ok(!picks.includes("b"), "the unavailable adapter is never chosen");
}

// Criterion 42 (#156 AC4): when exactly one adapter in the route is available,
// every worker uses it with no error — rotation degrades gracefully to that one
// adapter instead of erroring or stalling.
{
  const cfg = normalizeConfig({
    adapters: { a: { launch: ["a"] }, b: { launch: ["b"], requiresEnv: ["B_KEY"] } },
    routing: { default: { adapters: ["a", "b"], policy: "round-robin" }, labels: {} },
  });
  const cursors = {};
  for (let i = 0; i < 3; i++) {
    const r = resolveAdapter(cfg, [], { env: {}, onPath: () => true, cursors }); // only a is available
    assert.equal(r.name, "a", "the single available adapter is chosen every time");
    assert.ok(r.adapter, "a concrete adapter resolves — no error, no null");
    cursors[r.cursorKey] = r.nextCursor;
  }
}

// Criterion 43 (#156 AC5): an unknown policy value exits nonzero with a one-line
// error naming the route and the bad policy — enforced at the loader and surfaced
// by the CLI.
{
  assert.throws(
    () => normalizeConfig({ adapters: { a: { launch: ["a"] } }, routing: { default: { adapters: ["a"], policy: "bogus" } } }, "cfg.json"),
    (e) => e instanceof HerdConfigError && /routing\.default/.test(e.message) && /bogus/.test(e.message),
    "an unknown default-route policy is rejected, naming the entry and the bad policy",
  );
  assert.throws(
    () => normalizeConfig({ adapters: { a: { launch: ["a"] } }, routing: { default: "a", labels: { herd: { adapters: ["a"], policy: "spread" } } } }, "cfg.json"),
    (e) => e.message.includes(`routing.labels["herd"]`) && /spread/.test(e.message),
    "an unknown label-route policy is rejected, naming the label entry and the bad policy",
  );
  inTempDir(() => {
    mkdirSync(".ratchet", { recursive: true });
    writeFileSync(".ratchet/herd.json", JSON.stringify({ adapters: { a: { launch: ["a"] } }, routing: { default: { adapters: ["a"], policy: "bogus" } } }));
    const r = capture(() => main(["run"]));
    assert.equal(r.code, 1, "an unknown policy makes the supervisor exit nonzero");
    assert.match(r.err, /routing\.default/, "the CLI error names the route");
    assert.match(r.err, /bogus/, "the CLI error names the bad policy");
    assert.ok(!r.err.includes("\n"), "the error is a single line");
  });
}

// Criterion 44 (#156 AC6): the selection policy names no specific CLI or model —
// "failover" and "round-robin" are generic policy names, so herd.mjs stays
// framework-pure.
{
  const src = readFileSync(new URL("./herd.mjs", import.meta.url), "utf8");
  for (const token of [
    "tmux", "zellij", "wezterm",
    "opus", "sonnet", "haiku", "gpt-4", "gpt-5", "gemini", "llama", "mistral",
    "litellm", "openrouter", "rtk",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  ])
    assert.ok(!new RegExp(token, "i").test(src), `herd.mjs selection policy stays framework-pure: it references "${token}"`);
  assert.match(src, /round-robin/, "round-robin is a generic policy name, not a CLI or model");
}

// Criterion 45 (#156 AC7): each #156 criterion has exactly one test named after
// it, counted across herd.test.mjs and herd-dispatch.test.mjs (AC2 lives in the
// dispatch suite where round-robin dispatch is exercised end to end).
{
  const here = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  const dispatch = readFileSync(new URL("./herd-dispatch.test.mjs", import.meta.url), "utf8");
  const both = here + "\n" + dispatch;
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7"]) {
    const hits = (both.match(new RegExp(`#156 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#156 ${ac} has exactly one test named after it`);
  }
}

// Criterion (#163 AC1): an adapter may declare an optional `usage` mapping
// naming how to read costUsd, tokensIn, and tokensOut from that adapter's log
// output; a declared mapping survives normalization and drives extraction.
{
  const cfg = normalizeConfig({
    adapters: {
      a: {
        launch: ["cli", "{prompt}"],
        usage: {
          costUsd: "cost: \\$([0-9.]+)",
          tokensIn: "in=(\\d+)",
          tokensOut: "out=(\\d+)",
        },
      },
    },
    routing: { default: "a" },
  });
  assert.ok(cfg.adapters.a.usage, "a declared usage mapping is carried on the normalized adapter");
  assert.deepEqual(Object.keys(cfg.adapters.a.usage).sort(), [...USAGE_FIELDS].sort(), "the mapping names all three usage fields");
  const { values } = extractUsage(cfg.adapters.a.usage, "cost: $0.42\nin=1200 out=350\n");
  assert.deepEqual(values, { costUsd: 0.42, tokensIn: 1200, tokensOut: 350 }, "the mapping reads each number from the adapter's own log format");
}

// Criterion (#163 AC4): a usage mapping whose fields are missing or the wrong
// type exits nonzero at config-validation time with a one-line error naming the
// adapter and the offending field.
{
  const base = (usage) => ({ adapters: { claude: { launch: ["cli", "{prompt}"], usage } }, routing: { default: "claude" } });
  // Not an object at all.
  assert.throws(
    () => normalizeConfig(base("nope"), "cfg.json"),
    (e) => e instanceof HerdConfigError && e.message.includes("cfg.json") && /adapter "claude"/.test(e.message) && /usage/.test(e.message) && !e.message.includes("\n"),
    "a non-object usage is rejected, naming the file and adapter on one line",
  );
  // Each field, missing or wrong-typed, is named individually.
  for (const field of USAGE_FIELDS) {
    const full = { costUsd: "c=(\\d+)", tokensIn: "i=(\\d+)", tokensOut: "o=(\\d+)" };
    for (const bad of [{ ...full, [field]: undefined }, { ...full, [field]: 42 }, { ...full, [field]: "" }]) {
      assert.throws(
        () => normalizeConfig(base(bad), "cfg.json"),
        (e) => e instanceof HerdConfigError && new RegExp(`adapter "claude" usage\\.${field}`).test(e.message) && !e.message.includes("\n"),
        `usage.${field} that is ${JSON.stringify(bad[field])} is rejected, naming the adapter and field`,
      );
    }
  }
}

// Criterion (#163 AC6): the framework purity test still passes — no
// adapter-specific log format or model name appears in herd.mjs; usage
// extraction is driven entirely by the operator-supplied config regexes.
{
  const src = readFileSync(new URL("./herd.mjs", import.meta.url), "utf8");
  for (const token of [
    "opus", "sonnet", "haiku", "gpt-3", "gpt-4", "gpt-5", "davinci", "gemini", "llama", "mistral", // models
    "tmux", "zellij", "wezterm", // multiplexers
    "litellm", "openrouter", // proxies
  ])
    assert.ok(!new RegExp(token, "i").test(src), `herd.mjs stays framework-pure for usage capture: it must not reference "${token}"`);
  // Extraction reads only what the config's regex captures, not a baked format.
  const { values, unresolved } = extractUsage({ costUsd: "X=([0-9.]+)", tokensIn: "Y=(\\d+)", tokensOut: "Z=(\\d+)" }, "X=1.5 Y=10 Z=20");
  assert.deepEqual(values, { costUsd: 1.5, tokensIn: 10, tokensOut: 20 }, "extraction is config-driven — an arbitrary format works with no code change");
  assert.deepEqual(unresolved, [], "every field the config named was read from the log");
}

// Criterion (#163 AC7): each #163 criterion has exactly one test named after it,
// counted across herd.test.mjs (config/extraction/purity) and
// herd-survey.test.mjs (the worker-exit event behaviours).
{
  const here = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  const survey = readFileSync(new URL("./herd-survey.test.mjs", import.meta.url), "utf8");
  const both = here + "\n" + survey;
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5", "AC6", "AC7"]) {
    const hits = (both.match(new RegExp(`#163 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#163 ${ac} has exactly one test named after it`);
  }
}

// Criterion (#174 AC1): every herd script reads and writes the same `.ratchet/`
// files regardless of the directory it is invoked from within the repo — the
// root resolver and its derived paths are cwd-independent, and `init` invoked
// from a subdir writes (and `run` reads back) the one config at the repo root.
{
  const root = mkdtempSync(join(tmpdir(), "herd-root-"));
  mkdirSync(join(root, ".git"));
  const sub = join(root, "scripts", "nested");
  mkdirSync(sub, { recursive: true });
  const cwd = process.cwd();
  try {
    assert.equal(resolveRepoRoot(sub), resolveRepoRoot(root), "same root resolved from any subdir");
    assert.deepEqual(ratchetPaths(resolveRepoRoot(sub)), ratchetPaths(resolveRepoRoot(root)), "same .ratchet/* paths from any subdir");
    process.chdir(sub);
    assert.equal(capture(() => main(["init"])).code, 0, "init from a subdir succeeds");
    assert.ok(existsSync(join(root, CONFIG_PATH)), "init writes .ratchet/herd.json at the repo root");
    assert.ok(!existsSync(join(sub, ".ratchet")), "init never creates a stray .ratchet/ in the subdir");
    assert.equal(capture(() => main(["run"])).code, 0, "run from a subdir reads the root config back");
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
}

// Criterion (#174 AC2): invoked from outside any checkout, a herd script exits
// non-zero with a one-line error naming the path it could not resolve, and never
// silently creates a new `.ratchet/` directory.
{
  const outside = mkdtempSync(join(tmpdir(), "herd-nogit-"));
  const cwd = process.cwd();
  try {
    process.chdir(outside);
    const here = process.cwd();
    const r = capture(() => main(["init"]));
    assert.equal(r.code, 1, "outside a checkout exits non-zero");
    assert.ok(!r.err.includes("\n"), "the error is a single line");
    assert.ok(r.err.includes(here), "the error names the path it could not resolve");
    assert.ok(!existsSync(join(here, ".ratchet")), "no .ratchet/ is silently created");
    assert.throws(() => resolveRepoRoot(here), RepoRootError, "the failure is the dedicated RepoRootError");
  } finally {
    process.chdir(cwd);
    rmSync(outside, { recursive: true, force: true });
  }
}

// Criterion (#174 AC3): each #174 criterion above has exactly one test named
// after it, counted by scanning this file's own source.
{
  const here = readFileSync(new URL("./herd.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3"]) {
    const hits = (here.match(new RegExp(`#174 ${ac}\\)`, "g")) || []).length;
    assert.equal(hits, 1, `#174 ${ac} has exactly one test named after it`);
  }
}

console.log("PASS herd.test.mjs (45 criteria + issue #163: 4 criteria + issue #174: 3 criteria)");

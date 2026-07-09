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
import { main, loadConfig, normalizeConfig, substitute, resolveAdapter, HerdConfigError, DEFAULTS } from "./herd.mjs";

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

console.log("PASS herd.test.mjs (9 criteria)");

#!/usr/bin/env node
// pr-size-check.test.mjs — behaviour tests for the agent PR size gate.
// Zero dependencies. Run:  node scripts/pr-size-check.test.mjs
//
// One test per acceptance criterion of issue #11, exercised through the public
// interface (invoking scripts/pr-size-check.mjs as a subprocess with a fixture
// GATES.md and the PR counts/file details the workflow passes as env vars):
//   1. A PR over the configured limit fails the check (non-zero exit).
//   2. The failure message quotes the actual line/file counts, the limits, and
//      the split-and-requeue protocol from AGENTS.md step 3.
//   3. Thresholds are read from GATES.md, defaulting to ~400 lines / ~6 files.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath (not url.pathname) so a repo path containing spaces decodes
// back to a real filename rather than a percent-encoded one node can't open.
const SCRIPT = fileURLToPath(new URL("./pr-size-check.mjs", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "pr-size-test-"));

let n = 0;
// Run the check against a fixture GATES.md with the given PR counts. `gates`
// is the raw GATES.md body (may omit the size config to exercise defaults).
// `baseGates`, when given, is written to a separate file and passed as
// BASE_GATES_FILE — the base-branch config the check must judge by (#84).
async function check({ gates = "", baseGates, additions, deletions, changedFiles, files, filesRaw }) {
  const idx = n++;
  const gatesFile = join(dir, `GATES-${idx}.md`);
  await writeFile(gatesFile, gates);
  // Strip real-CI credentials so fetchPrFiles() never sees them: inside the
  // pr-gates job these are already set in the job environment, and without
  // this the subprocess inherits them via `...process.env` and silently
  // fetches the real, currently-open PR's files instead of using the
  // fixture's synthetic aggregates/PR_FILES_JSON.
  // BASE_GATES_FILE is stripped for the same reason and is the sharper trap:
  // the pr-gates job sets it on the step that runs run-gates.mjs, every suite
  // inherits it, and pr-size-check.mjs prefers it over GATES_FILE (#84). Left
  // in, the real base thresholds silently override every fixture below, so the
  // configurable-threshold cases invert and the gate fails in CI only. It is
  // re-added explicitly, per call, when a test passes `baseGates`.
  const { GITHUB_TOKEN: _t, GITHUB_REPOSITORY: _r, PR_NUMBER: _n, BASE_GATES_FILE: _b, ...restEnv } = process.env;
  const env = {
    ...restEnv,
    GATES_FILE: gatesFile,
  };
  if (baseGates !== undefined) {
    const baseFile = join(dir, `BASE-GATES-${idx}.md`);
    await writeFile(baseFile, baseGates);
    env.BASE_GATES_FILE = baseFile;
  }
  const setAggregates = () => {
    if (additions !== undefined) env.PR_ADDITIONS = String(additions);
    if (deletions !== undefined) env.PR_DELETIONS = String(deletions);
    if (changedFiles !== undefined) env.PR_CHANGED_FILES = String(changedFiles);
  };
  if (filesRaw !== undefined) {
    // A raw, unparseable file listing — simulates a transient failure to read
    // the per-file details, with the payload aggregates still present in env.
    env.PR_FILES_JSON = filesRaw;
    setAggregates();
  } else if (files) {
    env.PR_FILES_JSON = JSON.stringify(files);
  } else {
    setAggregates();
  }
  const res = spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env,
  });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

const withLimits = (lines, files) =>
  `# Gates\n\n## PR size limit\n\n- max_changed_lines: ${lines}\n- max_changed_files: ${files}\n`;
const withLimitsAndExcludes = (lines, files, excludes) =>
  `${withLimits(lines, files)}- exclude_paths: [${excludes.join(", ")}]\n`;

// --- criterion 1: over-limit PR fails, within-limit PR passes ----------------
{
  const over = await check({ gates: withLimits(400, 6), additions: 300, deletions: 150, changedFiles: 3 });
  assert.equal(over.code, 1, "a PR of 450 changed lines must fail the size check");

  const overFiles = await check({ gates: withLimits(400, 6), additions: 10, deletions: 5, changedFiles: 7 });
  assert.equal(overFiles.code, 1, "a PR touching 7 files must fail the size check");

  const within = await check({ gates: withLimits(400, 6), additions: 200, deletions: 100, changedFiles: 5 });
  assert.equal(within.code, 0, "a PR within both limits must pass");
}

// --- criterion 2: message quotes counts, limits, and the protocol ------------
{
  const { code, out } = await check({ gates: withLimits(400, 6), additions: 300, deletions: 150, changedFiles: 8 });
  assert.equal(code, 1, "over-limit PR fails");
  assert.ok(out.includes("450"), `message must quote the actual 450 changed lines, got:\n${out}`);
  assert.ok(out.includes("8"), `message must quote the actual file count 8, got:\n${out}`);
  assert.ok(out.includes("400") && out.includes("6"), `message must quote the limits 400/6, got:\n${out}`);
  assert.ok(/split/i.test(out), "message must mention splitting");
  assert.ok(out.includes("state:ready") && out.includes("state:in-progress"), "message must quote the requeue protocol labels");
  assert.ok(out.includes("AGENTS.md step 3"), "message must cite AGENTS.md step 3");
}

// --- criterion 3: thresholds configurable in GATES.md, default 400/6 ---------
{
  // Configurable: a tightened limit fails a PR the default would pass.
  const tight = await check({ gates: withLimits(10, 6), additions: 8, deletions: 5, changedFiles: 2 });
  assert.equal(tight.code, 1, "a 13-line PR must fail when max_changed_lines is tuned down to 10");

  // Default when GATES.md has no size config: 400 lines / 6 files.
  const defaultFail = await check({ gates: "# Gates\n(no size config here)\n", additions: 250, deletions: 151, changedFiles: 1 });
  assert.equal(defaultFail.code, 1, "401 changed lines must fail under the default 400 limit");

  const defaultPass = await check({ gates: "# Gates\n(no size config here)\n", additions: 250, deletions: 149, changedFiles: 6 });
  assert.equal(defaultPass.code, 0, "399 lines / 6 files must pass under the defaults");
}

// --- #59 criterion 1: configured path exclusions remove lines and files -------
{
  const files = [
    { filename: "src/app.js", additions: 5, deletions: 0 },
    { filename: "generated/client.js", additions: 500, deletions: 0 },
    { filename: "docs/report.md", additions: 0, deletions: 300 },
  ];
  const res = await check({
    gates: withLimitsAndExcludes(10, 1, ["generated/**", "docs/report.md"]),
    files,
  });
  assert.equal(res.code, 0, `excluded files must not count toward thresholds, got:\n${res.out}`);
  assert.ok(res.out.includes("5 hand-written changed line"), `only the included file should count, got:\n${res.out}`);
  assert.ok(res.out.includes("1 file"), `only the included file count should remain, got:\n${res.out}`);
}

// --- #59 criterion 2: common lockfiles are excluded by default ---------------
{
  const files = [
    { filename: "package-lock.json", additions: 500, deletions: 0 },
    { filename: "packages/web/pnpm-lock.yaml", additions: 500, deletions: 0 },
    { filename: "frontend/yarn.lock", additions: 500, deletions: 0 },
    { filename: "Cargo.lock", additions: 500, deletions: 0 },
    { filename: "poetry.lock", additions: 500, deletions: 0 },
    { filename: "services/api/go.sum", additions: 500, deletions: 0 },
    { filename: "src/app.js", additions: 3, deletions: 2 },
  ];
  const res = await check({ gates: withLimits(10, 1), files });
  assert.equal(res.code, 0, `default lockfile exclusions must keep the PR within limits, got:\n${res.out}`);
  for (const lockfile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "go.sum"]) {
    assert.ok(res.out.includes(lockfile), `output must name default exclusion ${lockfile}, got:\n${res.out}`);
  }
}

// --- #59 criterion 3: over-limit failures state applied exclusions -----------
{
  const files = [
    { filename: "src/app.js", additions: 20, deletions: 0 },
    { filename: "package-lock.json", additions: 500, deletions: 0 },
  ];
  const res = await check({ gates: withLimits(10, 6), files });
  assert.equal(res.code, 1, "included code over the limit must still fail");
  assert.ok(res.out.includes("Exclusions applied"), `failure must note applied exclusions, got:\n${res.out}`);
  assert.ok(res.out.includes("package-lock.json"), `failure must name the excluded lockfile, got:\n${res.out}`);
}

// --- #84 AC1: thresholds are read from the base branch's GATES.md, not the PR's.
// The PR raises its own limit to 10000; the base limit of 10 still applies, so an
// over-limit PR fails — it cannot edit what judges it -------------------------
{
  const res = await check({
    baseGates: withLimits(10, 6),
    gates: withLimits(10000, 6),
    additions: 30,
    deletions: 0,
    changedFiles: 1,
  });
  assert.equal(res.code, 1, "the base-branch limit must decide, not the PR's raised limit");
  assert.ok(res.out.includes("limit 10)"), `the base limit of 10 must be the one enforced, got:\n${res.out}`);
}

// --- #84 AC1 (exclusions): a PR cannot excuse its own files via an exclude_paths
// it adds only in its diff. Config comes from the base, which has no such exclude
{
  const files = [{ filename: "src/huge.js", additions: 500, deletions: 0 }];
  const res = await check({
    baseGates: withLimits(10, 6),
    gates: withLimitsAndExcludes(10, 6, ["src/**"]),
    files,
  });
  assert.equal(res.code, 1, "an exclude_paths added only in the PR must not spare its own files");
}

// --- #84 AC2: a PR that modifies GATES.md is flagged in the size check output --
{
  const res = await check({
    baseGates: withLimits(400, 6),
    gates: withLimits(500, 6),
    additions: 10,
    deletions: 0,
    changedFiles: 1,
  });
  assert.equal(res.code, 0, "a PR within the base limit still passes");
  assert.ok(/base branch's config/i.test(res.out) && /after merge/i.test(res.out), `a modified GATES.md must be flagged, got:\n${res.out}`);
}

// --- #84: identical base and PR config draws no false config-change flag ------
{
  const res = await check({
    baseGates: withLimits(400, 6),
    gates: withLimits(400, 6),
    additions: 10,
    deletions: 0,
    changedFiles: 1,
  });
  assert.equal(res.code, 0, "a within-limit PR passes");
  assert.ok(!/base branch's config/i.test(res.out), "identical base and PR config must not be flagged as a change");
}

// --- #212 AC1: files under the generated skill mirror directories are excluded
// from the changed-file count. ---
{
  const files = [
    { filename: ".claude/skills/foo/SKILL.md", additions: 200, deletions: 0 },
    { filename: "plugin/skills/foo/SKILL.md", additions: 200, deletions: 0 },
    { filename: "src/app.js", additions: 3, deletions: 2 },
  ];
  const res = await check({ gates: withLimits(10, 1), files });
  assert.equal(res.code, 0, `mirror files must not count toward thresholds, got:\n${res.out}`);
  assert.ok(res.out.includes("5 hand-written changed line"), `only the non-mirror file should count its lines, got:\n${res.out}`);
  assert.ok(res.out.includes("1 file"), `only the non-mirror file should count toward files, got:\n${res.out}`);
}

// --- #212 AC2: the canonical skill source under .agents/skills/ still counts
// toward the limit. ---
{
  const files = [
    { filename: ".agents/skills/foo/SKILL.md", additions: 8, deletions: 5 },
    { filename: "src/app.js", additions: 4, deletions: 0 },
  ];
  const res = await check({ gates: withLimits(400, 1), files });
  assert.equal(res.code, 1, "the canonical .agents/skills source must still count toward the file limit");
  assert.ok(res.out.includes("2 files"), `both the canonical skill and the source file must be counted, got:\n${res.out}`);
}

// --- #212 AC3: a PR changing one canonical skill file plus its two regenerated
// mirrors counts as one changed file for the gate. ---
{
  const files = [
    { filename: ".agents/skills/foo/SKILL.md", additions: 3, deletions: 1 },
    { filename: ".claude/skills/foo/SKILL.md", additions: 3, deletions: 1 },
    { filename: "plugin/skills/foo/SKILL.md", additions: 3, deletions: 1 },
  ];
  const res = await check({ gates: withLimits(400, 1), files });
  assert.equal(res.code, 0, "one canonical skill edit plus its two mirrors must count as a single changed file");
  assert.ok(res.out.includes("1 file"), `the canonical file plus two mirrors must count as one file, got:\n${res.out}`);
}

// --- #212 AC4: GATES.md documents the mirror exclusion alongside the existing
// lockfile exclusions. ---
{
  const gates = readFileSync(new URL("../GATES.md", import.meta.url), "utf8");
  const sizeSection = gates.slice(gates.indexOf("## PR size limit"));
  assert.ok(/exclude_paths/.test(sizeSection), "the size section must describe path exclusions");
  assert.ok(
    sizeSection.includes(".claude/skills") && sizeSection.includes("plugin/skills"),
    "GATES.md size section must document the generated skill mirror exclusions",
  );
}

// --- #212 AC5: every criterion above has exactly one test named after it. ---
{
  const self = readFileSync(new URL("./pr-size-check.test.mjs", import.meta.url), "utf8");
  for (const ac of ["AC1", "AC2", "AC3", "AC4", "AC5"]) {
    const hits = (self.match(new RegExp(`#212 ${ac}:`, "g")) || []).length;
    assert.equal(hits, 1, `#212 ${ac} must have exactly one test named after it`);
  }
}

// --- #90 AC1: a transient file-listing failure falls back to the event
// payload's aggregate counts, and the output states exclusions were not applied.
{
  const res = await check({
    gates: withLimits(400, 6),
    filesRaw: "{ not valid json —", // per-file listing unreadable (a GitHub hiccup)
    additions: 200,
    deletions: 100,
    changedFiles: 5,
  });
  assert.equal(res.code, 0, `a legitimate PR must not red-gate when file details are unavailable but aggregates are, got:\n${res.out}`);
  assert.ok(res.out.includes("300"), `the fallback must count the aggregate 300 changed lines, got:\n${res.out}`);
  assert.ok(/exclusion/i.test(res.out) && /not applied/i.test(res.out), `output must state that exclusions were not applied, got:\n${res.out}`);
}

// --- #90 AC2: GATES.md documents the exclude-pattern matching rules, including
// that * does not cross directory separators and bare filenames match at any depth.
{
  const gates = readFileSync(new URL("../GATES.md", import.meta.url), "utf8");
  const sizeSection = gates.slice(gates.indexOf("## PR size limit"));
  assert.ok(/cross/i.test(sizeSection) && /segment|separator/i.test(sizeSection), "GATES.md must document that * does not cross directory separators");
  assert.ok(/at any depth/i.test(sizeSection), "GATES.md must document that a bare filename matches at any depth");
}

// --- #484 AC1: the default exclude set covers generated artifacts beyond the
// lockfiles — snapshot directories, `.snap` files and the install manifest —
// with no host configuration at all (the fixture GATES.md has no exclude_paths).
{
  const files = [
    { filename: "__snapshots__/root.test.js.snap", additions: 400, deletions: 0 },
    { filename: "src/ui/__snapshots__/Button.test.js.snap", additions: 400, deletions: 0 },
    { filename: "crates/api/snapshots/render.snap", additions: 400, deletions: 0 },
    { filename: "ratchet-manifest.json", additions: 400, deletions: 0 },
    { filename: "Gemfile.lock", additions: 400, deletions: 0 },
    { filename: "composer.lock", additions: 400, deletions: 0 },
    { filename: "Pipfile.lock", additions: 400, deletions: 0 },
    { filename: "src/app.js", additions: 3, deletions: 2 },
  ];
  const res = await check({ gates: withLimits(10, 1), files });
  assert.equal(res.code, 0, `generated artifacts must be excluded without host configuration, got:\n${res.out}`);
  assert.ok(res.out.includes("5 hand-written changed line"), `only the hand-written file should count, got:\n${res.out}`);
  assert.ok(res.out.includes("1 file"), `only the hand-written file should count toward files, got:\n${res.out}`);
}

// --- #484 AC2: host-configured excludes extend the defaults rather than
// replacing them, and a host opts out of a single default explicitly with `!`.
{
  const files = [
    { filename: "package-lock.json", additions: 500, deletions: 0 },
    { filename: "generated/client.js", additions: 500, deletions: 0 },
    { filename: "src/app.js", additions: 3, deletions: 2 },
  ];
  const extend = await check({ gates: withLimitsAndExcludes(10, 1, ["generated/**"]), files });
  assert.equal(extend.code, 0, `a host exclude must add to the defaults, not replace them, got:\n${extend.out}`);
  assert.ok(extend.out.includes("5 hand-written changed line"), `the default lockfile exclusion must survive host config, got:\n${extend.out}`);

  const optOut = await check({
    gates: withLimitsAndExcludes(10, 6, ["generated/**", "!package-lock.json"]),
    files,
  });
  assert.equal(optOut.code, 1, "an explicit !package-lock.json opt-out must make the lockfile count again");
  assert.ok(optOut.out.includes("505 hand-written"), `the opted-out default's lines must be counted, got:\n${optOut.out}`);
}

// --- #484 AC3: the output states the hand-written line count and names every
// changed file excluded as generated, on both the passing and failing path.
{
  const files = [
    { filename: "src/app.js", additions: 3, deletions: 2 },
    { filename: "package-lock.json", additions: 500, deletions: 0 },
  ];
  const pass = await check({ gates: withLimits(10, 6), files });
  assert.equal(pass.code, 0, "a hand-written-small PR passes");
  assert.ok(pass.out.includes("5 hand-written changed line"), `the pass message must state the hand-written count, got:\n${pass.out}`);
  assert.ok(
    /Excluded as generated[\s\S]*package-lock\.json \(package-lock\.json\)/.test(pass.out),
    `the pass message must name the excluded file and the pattern that excluded it, got:\n${pass.out}`,
  );

  const fail = await check({ gates: withLimits(1, 6), files });
  assert.equal(fail.code, 1, "a hand-written-large PR fails");
  assert.ok(fail.out.includes("5 hand-written changed lines"), `the failure must state the hand-written count, got:\n${fail.out}`);
  assert.ok(/hand-written lines only/.test(fail.out), `the failure must state that the cap measures hand-written lines only, got:\n${fail.out}`);
  assert.ok(
    /Excluded as generated[\s\S]*package-lock\.json \(package-lock\.json\)/.test(fail.out),
    `the failure must name the excluded file and its pattern, got:\n${fail.out}`,
  );
}

// --- #484 AC4: the verdict tracks hand-written lines in both directions — a
// generated-dominated diff still fails when the hand-written part is over the
// cap, and a big lockfile does not fail an under-cap PR.
{
  const overDespiteGenerated = await check({
    gates: withLimits(400, 6),
    files: [
      { filename: "pnpm-lock.yaml", additions: 9000, deletions: 0 },
      { filename: "src/app.js", additions: 401, deletions: 0 },
    ],
  });
  assert.equal(overDespiteGenerated.code, 1, "401 hand-written lines must fail even when the lockfile dominates the diff");

  const underWithGenerated = await check({
    gates: withLimits(400, 6),
    files: [
      { filename: "pnpm-lock.yaml", additions: 9000, deletions: 0 },
      { filename: "src/app.js", additions: 399, deletions: 0 },
    ],
  });
  assert.equal(underWithGenerated.code, 0, `399 hand-written lines plus a large lockfile must pass, got:\n${underWithGenerated.out}`);
}

console.log("PASS pr-size-check.test.mjs (57 assertions)");

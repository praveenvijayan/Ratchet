#!/usr/bin/env node
// debt-scan.test.mjs — one test per acceptance criterion of issue #481 (plan
// 0202-debt-ingestion-generic): deferred scope declared in a merged PR body must
// become a plan file, or be explicitly retired, before the planning PR goes
// green. Drives main() against an in-memory GitHub API and a throwaway repo
// directory, so nothing leaves the process.
// Fixture plan files deliberately avoid `NNNN-slug.md` names: this file also
// reads the repo's plan/README.md, and the #191 guard forbids a test that does
// both. Zero dependencies. Run: node scripts/debt-scan.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, deferrals, readConfig } from "./debt-scan.mjs";

const auth = () => ({ token: "test-token", repo: "o/r" });
const respond = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });

// Merged PRs the pulls endpoint reports. `body` carries the declaration.
const fetchFor = (pulls) => async (url) => {
  const { pathname, searchParams } = new URL(url);
  if (pathname !== "/repos/o/r/pulls") throw new Error(`unexpected request: ${url}`);
  return respond(Number(searchParams.get("page")) === 1 ? pulls : []);
};

const merged = (number, ...items) => ({
  number, merged_at: "2026-07-01T00:00:00Z",
  body: `Closes #1\n\n## Deferred scope\n${items.map((i) => `- ${i}`).join("\n")}\n`,
});

// A throwaway repo: GATES.md config, plan files, and any source files given.
async function repo({ gates = "", plans = {}, done = {}, sources = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "debt-scan-"));
  await writeFile(join(cwd, "GATES.md"), `# Gates\n\n## Deferred-scope debt scan\n\n${gates}\n`);
  await mkdir(join(cwd, "plan", "done"), { recursive: true });
  for (const [name, text] of Object.entries(plans)) await writeFile(join(cwd, "plan", name), text);
  for (const [name, text] of Object.entries(done)) await writeFile(join(cwd, "plan", "done", name), text);
  for (const [name, text] of Object.entries(sources)) {
    await mkdir(join(cwd, name, ".."), { recursive: true });
    await writeFile(join(cwd, name), text);
  }
  return { cwd, listFiles: () => Object.keys(sources) };
}

const run = async (pulls, fixture) =>
  main({ auth, fetchImpl: fetchFor(pulls), cwd: fixture.cwd, listFiles: fixture.listFiles });

const fails = async (pulls, fixture) => {
  try {
    await run(pulls, fixture);
  } catch (e) {
    return e;
  }
  return null;
};

// --- Criterion 1: every deferral in a merged PR body that no plan file covers
// is listed, the scan exits non-zero, and each PR number is named. A deferral a
// plan file DOES cover — active or archived — is not outstanding debt.
{
  const fixture = await repo({
    plans: { "covers-pr-12.md": "---\ntitle: t\n---\nIngests deferred scope from #12\n" },
    done: { "archived-pr-13.md": "---\ntitle: t\n---\nIngests deferred scope from #13\n" },
  });
  const err = await fails([merged(11, "the retry path"), merged(12, "covered work"), merged(13, "archived work")], fixture);
  assert.ok(err, "unplanned deferred scope must make the scan exit non-zero");
  assert.deepEqual(err.findings.unplanned.map((u) => u.pr), [11], `only the uncovered PR is debt, got: ${JSON.stringify(err.findings.unplanned)}`);
  assert.equal(err.findings.unplanned[0].item, "the retry path", "the declaration text must be carried through");
}

// --- Criterion 2: the source-marker scan runs only when the host configures a
// regex; when configured, unmatched markers are reported with file:line.
{
  const bare = await repo({ sources: { "src/a.js": "// DEFERRED(no-such-plan)\n" } });
  const clean = await run([], bare);
  assert.deepEqual(clean.markers, [], "with no deferral_marker configured the source scan must not run");

  const configured = await repo({
    gates: "- deferral_marker: DEFERRED\\(([\\w-]+)\\)",
    plans: { "marker-target.md": "---\ntitle: t\n---\nbody\n" },
    sources: { "src/a.js": "one\n// DEFERRED(no-such-plan)\n", "src/b.js": "// DEFERRED(marker-target)\n" },
  });
  const err = await fails([], configured);
  assert.ok(err, "an unmatched source marker must make the scan exit non-zero");
  assert.deepEqual(
    err.findings.markers.map((m) => m.where),
    ["src/a.js:2"],
    `only the marker naming no plan file is debt, reported with file:line, got: ${JSON.stringify(err.findings.markers)}`,
  );
}

// --- Criterion 3: the check passes once every listed deferral is covered by a
// plan file OR explicitly retired — the two exits from the same failure.
{
  const pulls = [merged(21, "the migration")];
  assert.ok(await fails(pulls, await repo()), "unplanned debt must fail the planning-PR check");

  const byPlan = await repo({ plans: { "ingests-pr-21.md": "---\ntitle: t\n---\nIngests deferred scope from #21\n" } });
  assert.deepEqual((await run(pulls, byPlan)).unplanned, [], "covering the deferral with a plan file must clear it");

  const byRetirement = await repo({ gates: "- retired_deferrals: [#21]" });
  assert.deepEqual((await run(pulls, byRetirement)).unplanned, [], "retiring the deferral must clear it too");
}

// --- Criterion 4: the failure output names, per item, both ways out; and
// plan/README.md documents them.
{
  const lines = [];
  const realError = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    await fails([merged(31, "the audit trail")], await repo());
  } finally {
    console.error = realError;
  }
  const out = lines.join("\n");
  assert.match(out, /PR #31 deferred: the audit trail/, `the failure must name the PR and the deferral, got:\n${out}`);
  assert.match(out, /cover\s+— add a plan\/\*\.md .*Ingests deferred scope from #31/, `the failure must spell out how to cover it, got:\n${out}`);
  assert.match(out, /retire\s+— add 31 to 'retired_deferrals'/, `the failure must spell out how to retire it, got:\n${out}`);

  const readme = await import("node:fs").then((fs) => fs.readFileSync(new URL("../plan/README.md", import.meta.url), "utf8"));
  assert.match(readme, /## Ingesting deferred scope/, "plan/README.md must document deferral ingestion");
  assert.match(readme, /Ingests deferred scope from #/, "plan/README.md must document the covering mechanism");
  assert.match(readme, /retired_deferrals/, "plan/README.md must document the retiring mechanism");
}

// --- Criterion 5 (regression): a repo with no deferrals and no marker config
// exits zero and scans nothing.
{
  const result = await run([{ number: 41, merged_at: "2026-07-01T00:00:00Z", body: "Closes #1\n" }], await repo());
  assert.deepEqual(result, { unplanned: [], markers: [] }, `a clean repo must exit zero, got: ${JSON.stringify(result)}`);
}

// --- Error paths: an unmergeable PR is not debt, and a broken deferral_marker
// fails with a readable message instead of a raw regex error.
{
  const open = await run([{ number: 51, merged_at: null, body: "## Deferred scope\n- never merged\n" }], await repo());
  assert.deepEqual(open.unplanned, [], "a PR that never merged declares no debt");

  const broken = await fails([], await repo({ gates: "- deferral_marker: DEFERRED\\(([\\w-]+" }));
  assert.match(broken.message, /not a valid regular expression/, `a broken marker must explain itself, got: ${broken.message}`);
  const groupless = await fails([], await repo({ gates: "- deferral_marker: DEFERRED" }));
  assert.match(groupless.message, /must capture the plan slug/, `a capture-less marker must explain itself, got: ${groupless.message}`);
}

// --- Unit cover for the two pure cores the orchestration leans on.
assert.deepEqual(deferrals("## Deferred scope\n- a\n- b\n\n## Tests\n- not a deferral\n"), ["a", "b"]);
assert.deepEqual(deferrals("no section here"), []);
assert.equal(readConfig("- deferral_marker: none\n").marker, null, "'none' must read as unconfigured");

console.log("PASS debt-scan.test.mjs (5 criteria + error paths)");

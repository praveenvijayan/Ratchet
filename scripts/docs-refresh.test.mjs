#!/usr/bin/env node
// docs-refresh.test.mjs — regression checks for docs that describe shipped
// Ratchet mechanisms. Zero dependencies. Run: node scripts/docs-refresh.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const docs = read("DOCS.md");
const readme = read("README.md");
const planReadme = read("plan/README.md");
const agents = read("AGENTS.md");

// #60 AC1: DOCS.md's sweep section describes the renewable lease, heartbeat
// marker, and all three swept states, matching the code.
{
  assert.match(docs, /state:in-progress[\s\S]*state:in-review[\s\S]*state:changes-requested/, "DOCS must name all swept states");
  assert.match(docs, /<!-- ratchet-heartbeat -->/, "DOCS must document the heartbeat marker");
  assert.match(docs, /newest proof of life|Freshness is the newest/, "DOCS must describe renewable lease freshness");
}

// #60 AC2: DOCS.md inventories all workflows and every shipped script.
{
  const workflows = readdirSync(`${root}.github/workflows`).filter((f) => f.endsWith(".yml")).sort();
  for (const workflow of workflows) assert.ok(docs.includes(workflow), `DOCS must list workflow ${workflow}`);

  const scripts = readdirSync(`${root}scripts`).filter((f) => !f.startsWith(".")).sort();
  for (const script of scripts) assert.ok(docs.includes(script), `DOCS must list script ${script}`);
}

// #60 AC3: DOCS.md's plan-format section shows optional Non-functional and
// Test notes sections.
{
  assert.match(docs, /## Non-functional[\s\S]*## Test notes/, "DOCS plan example must show both optional sections");
  assert.match(docs, /Optional `## Non-functional` and `## Test notes` sections/, "DOCS must explain optional sections");
}

// #60 AC4: README's skills list includes /ratchet-next and /ratchet-metrics.
{
  assert.ok(readme.includes("**`/ratchet-next`**"), "README must list /ratchet-next");
  assert.ok(readme.includes("**`/ratchet-metrics`**"), "README must list /ratchet-metrics");
}

// #60 AC5: plan/README.md documents invalid-priority hard-skip, unknown-key
// warning, and the cycle gate.
{
  assert.match(planReadme, /invalid priority|Priority is a closed set/, "plan README must document invalid-priority skip");
  assert.match(planReadme, /unknown frontmatter key/, "plan README must document unknown-key warnings");
  assert.match(planReadme, /Blocked-by cycles are a hard gate|cycle is a deadlock/, "plan README must document the cycle gate");
}

// #60 AC6: AGENTS.md names pr-gates CI and the extended sweep states where it
// describes the loop.
{
  assert.match(agents, /`pr-gates` workflow[\s\S]*`gates` job[\s\S]*`size` job/, "AGENTS must name the pr-gates CI check");
  assert.match(agents, /`state:in-progress`[\s\S]*`state:in-review`[\s\S]*`state:changes-requested`/, "AGENTS must name extended sweep states");
}

console.log("PASS docs-refresh.test.mjs (6 criteria, documentation inventory)");

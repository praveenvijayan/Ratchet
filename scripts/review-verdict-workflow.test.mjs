#!/usr/bin/env node
// review-verdict-workflow.test.mjs — guards the automation contract that lives
// only in review-verdict.yml, for issue #266. The DECISION logic (what flips,
// what no-ops) is exercised behaviourally in review-verdict.test.mjs; what this
// file locks is the workflow's `permissions` block.
//
// A non-empty `permissions:` block drops every default GitHub grants,
// `contents: read` included — so `actions/checkout` fails with "repository not
// found" on private repos and the flip never runs. The workflow therefore MUST
// grant `contents: read` alongside `issues: write`. This test fails the moment
// the block regresses to `issues: write` alone — exactly the regression #266
// exists to prevent.
//
// Zero dependencies. Run:  node scripts/review-verdict-workflow.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wf = readFileSync(
  fileURLToPath(new URL("../.github/workflows/review-verdict.yml", import.meta.url)),
  "utf8",
);

// Isolate the top-level `permissions:` block (its indented lines, up to the
// next top-level key) so the assertions can't be satisfied by a `permissions:`
// nested inside a job or by a comment elsewhere in the file.
const permBlock = wf.match(/\npermissions:\n((?:[ \t]+\S[^\n]*\n)+)/)?.[1] ?? "";
assert.ok(permBlock, "review-verdict.yml must declare a top-level `permissions:` block");

const grants = Object.fromEntries(
  [...permBlock.matchAll(/^[ \t]+([a-z-]+):[ \t]*([a-z-]+)/gim)].map((m) => [m[1], m[2]]),
);

// The checkout grant: without it, a non-empty permissions block silently drops
// `contents: read` and `actions/checkout` fails on private repos.
assert.equal(
  grants["contents"],
  "read",
  "the permissions block must grant `contents: read` so actions/checkout can clone private repos",
);

// The label-write grant the workflow actually needs to flip the issue — must
// survive alongside the checkout grant, never be replaced by it.
assert.equal(
  grants["issues"],
  "write",
  "the permissions block must still grant `issues: write` to flip the mapped issue's label",
);

// The exact regression #266 fixes: a block whose only grant is `issues: write`.
const onlyIssuesWrite =
  Object.keys(grants).length === 1 && grants["issues"] === "write";
assert.ok(
  !onlyIssuesWrite,
  "the permissions block must not regress to `issues: write` alone (contents: read must stay)",
);

console.log("PASS review-verdict-workflow.test.mjs (4 assertions)");

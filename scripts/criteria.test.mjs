#!/usr/bin/env node
// criteria.test.mjs — the criteria are the test plan. One test per acceptance
// criterion of issue #5, exercised through the public interface
// (classifyUnblock) that the unblock-dependents workflow actually calls.
// Zero dependencies. Run:  node scripts/criteria.test.mjs

import assert from "node:assert/strict";
import { classifyUnblock } from "./criteria.mjs";

const CLOSED = 42;
const withCriteria = `Some body.

## Acceptance criteria
- [ ] does the observable thing

<!-- plan-id: 0003-unblock-recheck-criteria -->`;
const withoutCriteria = `Some body with no criteria block at all.

<!-- plan-id: 0003-unblock-recheck-criteria -->`;

// Criterion 1: an unblocked issue whose body contains at least one `- [ ]`
// item under `## Acceptance criteria` is promoted to state:ready.
{
  const { state } = classifyUnblock(withCriteria, CLOSED);
  assert.equal(state, "state:ready", `criteria present must promote to ready, got ${state}`);
}

// Criterion 2: an unblocked issue without such a criteria block is set to
// state:draft, never state:ready.
{
  const { state } = classifyUnblock(withoutCriteria, CLOSED);
  assert.equal(state, "state:draft", `no criteria must hold at draft, got ${state}`);
  assert.notEqual(state, "state:ready", "no-criteria issue must never be ready");
}

// Criterion 3: the comment on a draft demotion states acceptance criteria are
// missing and names the plan file (slug from the `plan-id` marker) to fix.
{
  const { comment } = classifyUnblock(withoutCriteria, CLOSED);
  assert.match(comment, /acceptance criteria/i, "draft comment must mention acceptance criteria");
  assert.match(comment, /no/i, "draft comment must say criteria are absent");
  assert.match(comment, /plan\/0003-unblock-recheck-criteria\.md/, "draft comment must name the plan file from the plan-id marker");
}

// Error path (Hard Rule 8): a body with no plan-id marker still yields a clear,
// non-crashing message instead of naming an undefined file.
{
  const { state, comment } = classifyUnblock("no criteria, no marker", CLOSED);
  assert.equal(state, "state:draft");
  assert.match(comment, /no `plan-id` marker found/, "missing marker must be surfaced, not crash");
}

console.log("PASS criteria.test.mjs (6 assertions)");

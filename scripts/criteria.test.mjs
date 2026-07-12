#!/usr/bin/env node
// criteria.test.mjs — the criteria are the test plan. One test per acceptance
// criterion of issue #5, exercised through the public interface
// (classifyUnblock) that the unblock-dependents workflow actually calls.
// Zero dependencies. Run:  node scripts/criteria.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyUnblock, classifyRequeue, planSlug, formatPlanMarker, isPlanMarkerLine } from "./criteria.mjs";

const CLOSED = 42;
const withCriteria = `Some body.

## Acceptance criteria
- [ ] does the observable thing

<!-- plan-id: 0003-unblock-recheck-criteria -->`;
const withoutCriteria = `Some body with no criteria block at all.

<!-- plan-id: 0003-unblock-recheck-criteria -->`;
const emptyCriteriaWithChecklistElsewhere = `Some body.

## Acceptance criteria

## Test notes
- [ ] this is not an acceptance criterion

<!-- plan-id: 0032-criteria-scope-checkboxes -->`;
const criteriaChecklistInsideSection = `Some body.

## Acceptance criteria
- [ ] this is an acceptance criterion

## Test notes
- [ ] this is extra test guidance

<!-- plan-id: 0032-criteria-scope-checkboxes -->`;

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

// #57 criterion 1: a body whose only `- [ ]` items sit outside the
// `## Acceptance criteria` section classifies as draft.
{
  const { state } = classifyUnblock(emptyCriteriaWithChecklistElsewhere, CLOSED);
  assert.equal(state, "state:draft", `out-of-section checkbox must not make issue ready, got ${state}`);
}

// #57 criterion 2: a body with at least one `- [ ]` inside the
// `## Acceptance criteria` section still classifies as ready.
{
  const { state } = classifyUnblock(criteriaChecklistInsideSection, CLOSED);
  assert.equal(state, "state:ready", `in-section checkbox must make issue ready, got ${state}`);
}

// --- classifyRequeue: the sweep's ready-vs-draft gate (issue #54) ------------
// A sweep-to-ready decision, as decideSweep produces it. classifyRequeue is the
// shared gate the sweep runs against the write-time body before applying it.
const readyDecision = {
  sweep: true,
  deleteRef: false,
  targetState: "state:ready",
  reason: "Stale rework swept: `agent/issue-99` is `state:changes-requested` with no activity for >2h.",
  comment: "Stale rework swept: `agent/issue-99` is `state:changes-requested` with no activity for >2h. Issue returned to `state:ready` so it can be re-picked.",
};

// #54 AC1: a swept issue whose live body still carries acceptance criteria is
// requeued to state:ready unchanged.
{
  const r = classifyRequeue(readyDecision, withCriteria);
  assert.equal(r.targetState, "state:ready", "criteria present must requeue to ready");
  assert.equal(r.comment, readyDecision.comment, "a criteria-bearing issue keeps the original ready comment");
}

// #54 AC1: a swept issue whose body lost its acceptance criteria is held at
// state:draft, never state:ready, with a comment that explains why and names
// the plan file (slug from the plan-id marker) to fix.
{
  const r = classifyRequeue(readyDecision, withoutCriteria);
  assert.equal(r.targetState, "state:draft", "lost criteria must be held at draft");
  assert.notEqual(r.targetState, "state:ready", "a criteria-less issue must never be requeued as ready");
  assert.match(r.comment, /acceptance criteria/i, "draft comment must mention acceptance criteria");
  assert.match(r.comment, /state:draft/, "draft comment must state the held outcome");
  assert.match(r.comment, /plan\/0003-unblock-recheck-criteria\.md/, "draft comment must name the plan file to fix");
  assert.match(r.comment, /Stale rework swept/, "draft comment keeps the sweep's diagnostic reason");
}

// #54 AC1 error path (Hard Rule 8): a criteria-less body with no plan-id marker
// still yields a clear message rather than naming an undefined file.
{
  const r = classifyRequeue(readyDecision, "no criteria, no marker");
  assert.equal(r.targetState, "state:draft");
  assert.match(r.comment, /no `plan-id` marker found/, "missing marker must be surfaced, not crash");
}

// #54 AC1: a deliberate non-ready sweep target (state:blocked for merged work
// awaiting human cleanup) is never re-gated — the criteria check applies only
// to the state:ready outcome.
{
  const blockedDecision = { ...readyDecision, targetState: "state:blocked", comment: "merged work parked for cleanup" };
  const r = classifyRequeue(blockedDecision, withoutCriteria);
  assert.equal(r.targetState, "state:blocked", "a non-ready target must pass through untouched");
  assert.equal(r.comment, blockedDecision.comment, "a non-ready target keeps its comment");
}

// #345 AC1: criteria.mjs exports read + write of the `<!-- plan-id: <slug> -->`
// marker from one definition, tolerating optional whitespace around `plan-id:`
// and the slug. Reading a marker written by formatPlanMarker round-trips.
{
  const slug = "0154-plan-id-marker-single-authority";
  // Read tolerates spacing variants — the exact bug #345 fixes.
  assert.equal(planSlug(`b\n\n<!-- plan-id: ${slug} -->`), slug, "normal spacing resolves");
  assert.equal(planSlug(`<!--plan-id:${slug}-->`), slug, "no surrounding whitespace resolves");
  assert.equal(planSlug(`<!--   plan-id:    ${slug}   -->`), slug, "extra internal whitespace resolves");
  assert.equal(planSlug("body with no marker"), null, "a marker-less body yields null, not a throw");
  // Write is canonical and round-trips through the reader.
  assert.equal(formatPlanMarker(slug), `<!-- plan-id: ${slug} -->`, "formatPlanMarker renders the canonical marker");
  assert.equal(planSlug(formatPlanMarker(slug)), slug, "what is written can be read back");
  // isPlanMarkerLine matches a whole marker line (any spacing) and nothing else.
  assert.equal(isPlanMarkerLine(`<!-- plan-id: ${slug} -->`), true, "a bare marker line matches");
  assert.equal(isPlanMarkerLine(`   <!--plan-id:${slug}-->   `), true, "a spaced marker line matches");
  assert.equal(isPlanMarkerLine(`text <!-- plan-id: ${slug} --> more`), false, "a marker mid-line is not a marker line");
  assert.equal(isPlanMarkerLine("## Acceptance criteria"), false, "an ordinary line does not match");
}

// #345 AC2: every consumer obtains the slug via criteria.mjs — no other file
// under scripts/ carries its own plan-id regex. Scan the source: only
// criteria.mjs may contain a slash-delimited regex literal mentioning plan-id.
{
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const REGEX_LITERAL = /\/[^/\n]*plan-id[^/\n]*\//;
  const offenders = readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && f !== "criteria.mjs")
    .filter((f) => REGEX_LITERAL.test(readFileSync(join(scriptsDir, f), "utf8")));
  assert.deepEqual(offenders, [], `these files still define their own plan-id regex instead of importing from criteria.mjs: ${offenders.join(", ")}`);
}

// #375 AC1: planSlug resolves the LAST `plan-id` marker in a body. plan-sync
// always appends the real marker as the final line, so a plan whose prose quotes
// the marker syntax earlier (a placeholder or an example slug) must still resolve
// to its own appended marker — not the quoted string. A first-match parser keyed
// the dedup map on the placeholder and re-created the issue on every sync run:
// the #345/#349/#356 triplicate bug.
{
  const real = "0161-plan-sync-marker-position-idempotency";
  const bodyQuotesMarker =
    "This plan discusses the `<!-- plan-id: 0000-example-quoted -->` marker syntax.\n\n" +
    "## Acceptance criteria\n- [ ] something\n\n" +
    `<!-- plan-id: ${real} -->`;
  assert.equal(planSlug(bodyQuotesMarker), real, "planSlug must resolve the last (appended) marker, not a quoted placeholder");
  // The last-match rule leaves the common single-marker body unchanged.
  assert.equal(planSlug(`b\n\n<!-- plan-id: ${real} -->`), real, "a single-marker body still resolves to its slug");
  // An issue body carrying more than one marker-shaped comment resolves to the
  // last one (Test notes fixture).
  assert.equal(
    planSlug("<!-- plan-id: 0000-first -->\nmiddle\n<!-- plan-id: 0000-second -->\ntail\n<!-- plan-id: 0000-third -->"),
    "0000-third",
    "multiple markers must resolve to the last occurrence",
  );
  assert.equal(planSlug("no marker at all"), null, "a marker-less body still yields null, not a throw");
}

// #375 AC2: every consumer obtains the slug only through the criteria.mjs
// export, and no other file under scripts/ carries its own plan-id regex. The
// slug-resolution rule (including AC1's last-match fix) lives in exactly one
// place, so it can never drift between plan-sync, archive, and verify.
{
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const REGEX_LITERAL = /\/[^/\n]*plan-id[^/\n]*\//;
  const files = readdirSync(scriptsDir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && f !== "criteria.mjs");
  const offenders = files.filter((f) => REGEX_LITERAL.test(readFileSync(join(scriptsDir, f), "utf8")));
  assert.deepEqual(offenders, [], `these files define their own plan-id regex instead of importing from criteria.mjs: ${offenders.join(", ")}`);
  // The slug-bearing consumers actually import planSlug from criteria.mjs.
  for (const consumer of ["plan-sync.mjs", "archive-closed-plans.mjs"]) {
    const src = readFileSync(join(scriptsDir, consumer), "utf8");
    assert.match(src, /import\s*\{[^}]*\bplanSlug\b[^}]*\}\s*from\s*["']\.\/criteria\.mjs["']/, `${consumer} must import planSlug from criteria.mjs`);
  }
}

// #375 AC6: every acceptance criterion of #375 has exactly one test named after
// it. This suite plus plan-sync.test.mjs must carry each `#375 AC<n>` header
// exactly once (AC1/AC2/AC6 here, AC3/AC4/AC5 there) so the traceability the
// criterion demands can never silently rot.
{
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const combined =
    readFileSync(join(scriptsDir, "criteria.test.mjs"), "utf8") +
    readFileSync(join(scriptsDir, "plan-sync.test.mjs"), "utf8");
  for (let n = 1; n <= 6; n++) {
    const header = `#375 AC${n}:`;
    const count = combined.split(header).length - 1;
    assert.equal(count, 1, `#375 AC${n} must have exactly one test named after it, found ${count}`);
  }
}

console.log("PASS criteria.test.mjs (16 assertions + #345 AC1/AC2 + #375 AC1/AC2/AC6)");

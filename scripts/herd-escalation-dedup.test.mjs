#!/usr/bin/env node
// herd-escalation-dedup.test.mjs — the acceptance criteria of issue #426
// (plan 0177) are the test plan: exactly one test per criterion of deduplicating
// escalations at the source, exercised through the public interface of the
// writer (herd-survey.mjs) and the dashboard reader (herd-ui.mjs). Fully offline:
// fixtures in temp dirs, an injected warn, a fixed clock. Zero dependencies.
// Run:  node scripts/herd-escalation-dedup.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { appendEscalation } from "./herd-survey.mjs";
import { parseEscalations, dedupEscalations, resolveEscalations } from "./herd-ui.mjs";

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0); // fixed clock — no Date.now dependence
const MIN = 60_000;

function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "esc-dedup-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const headings = (path) => (readFileSync(path, "utf8").match(/^## /gm) || []).length;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// Criterion 1: an escalation whose issue and reason-class match an existing
// unresolved entry updates that entry's occurrence count and last-seen timestamp
// instead of appending a new block.
test("matching unresolved entry bumps count and last-seen timestamp, no new block", () => {
  inTemp((dir) => {
    const esc = join(dir, "esc.md");
    const ev = join(dir, "events.jsonl");
    // Same cause (issue + normalized reason), variable pid — one entry expected.
    appendEscalation(esc, { now: NOW, issue: 9, what: "worker pid 100 is not alive" }, { eventsPath: ev });
    appendEscalation(esc, { now: NOW + 5 * MIN, issue: 9, what: "worker pid 200 is not alive" }, { eventsPath: ev });
    assert.equal(headings(esc), 1, "the recurrence updates the one entry, never appends a second");
    const text = readFileSync(esc, "utf8");
    assert.match(text, /- Occurrences: 2/, "occurrence count is bumped to 2");
    assert.match(text, new RegExp(`## ${new Date(NOW + 5 * MIN).toISOString()} `), "heading carries the last-seen timestamp");
    assert.doesNotMatch(text, new RegExp(new Date(NOW).toISOString()), "the original (older) timestamp is replaced, not kept");

    // "Unresolved" qualifier: an acknowledged (resolved) match is NOT merged —
    // its recurrence starts a fresh entry so the operator is re-alerted.
    const esc2 = join(dir, "esc2.md");
    appendEscalation(esc2, { now: NOW, issue: 9, what: "worker pid 1 is not alive" }, { eventsPath: ev });
    const acked = new Set(["9\tworker pid N is not alive"]);
    appendEscalation(esc2, { now: NOW + MIN, issue: 9, what: "worker pid 2 is not alive" }, { eventsPath: ev, acknowledged: acked });
    assert.equal(headings(esc2), 2, "a recurrence of an acknowledged cause appends rather than merging");
  });
});

// Criterion 2: a new reason-class for the same issue, or the same reason-class
// for a different issue, still appends a new entry.
test("a new reason-class or a new issue appends a distinct entry", () => {
  inTemp((dir) => {
    const esc = join(dir, "esc.md");
    const ev = join(dir, "events.jsonl");
    appendEscalation(esc, { now: NOW, issue: 9, what: "worker pid 1 is not alive" }, { eventsPath: ev });
    // Same issue, different reason-class -> append.
    appendEscalation(esc, { now: NOW + MIN, issue: 9, what: "stale claim ref lingers" }, { eventsPath: ev });
    // Same reason-class, different issue -> append.
    appendEscalation(esc, { now: NOW + 2 * MIN, issue: 10, what: "worker pid 2 is not alive" }, { eventsPath: ev });
    assert.equal(headings(esc), 3, "distinct (issue, reason-class) pairs each get their own entry");
  });
});

// Criterion 3: every escalation call path (survey, dispatch, monitor, reconcile,
// review) writes through the deduplicating writer — no writer can bypass it.
test("every escalation call path funnels through appendEscalation, none writes the file directly", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const mod of ["herd-survey.mjs", "herd-dispatch.mjs", "herd-monitor.mjs", "herd-verify.mjs", "herd-review.mjs"]) {
    const src = readFileSync(join(here, mod), "utf8");
    assert.match(src, /appendEscalation\s*\(/, `${mod} escalates through appendEscalation`);
    // No path may write the escalation log itself — only appendEscalation may.
    if (mod !== "herd-survey.mjs") {
      assert.doesNotMatch(src, /(appendFileSync|writeFileSync)\s*\(\s*escalationsPath/, `${mod} never writes the escalation log directly`);
    }
  }
});

// Criterion 4: a simulated run where one cause persists across many polls ends
// with exactly one entry for it, regardless of run length.
test("a cause persisting across many polls converges to exactly one entry", () => {
  inTemp((dir) => {
    const esc = join(dir, "esc.md");
    const ev = join(dir, "events.jsonl");
    const TICKS = 40;
    for (let i = 0; i < TICKS; i++) {
      appendEscalation(esc, { now: NOW + i * MIN, issue: 7, what: `worker pid ${i} is not alive` }, { eventsPath: ev });
    }
    assert.equal(headings(esc), 1, "regardless of run length the persistent cause is one entry");
    assert.match(readFileSync(esc, "utf8"), new RegExp(`- Occurrences: ${TICKS}`), "the entry counts every occurrence");
  });
});

// Criterion 5: the dashboard's escalation rendering and resolution logic (0082)
// still parses the updated entries, showing the occurrence count and latest
// timestamp.
test("the dashboard parses a deduped entry, reporting occurrence count and latest timestamp", () => {
  inTemp((dir) => {
    const esc = join(dir, "esc.md");
    const ev = join(dir, "events.jsonl");
    appendEscalation(esc, { now: NOW, issue: 5, what: "worker pid 1 is not alive" }, { eventsPath: ev });
    appendEscalation(esc, { now: NOW + MIN, issue: 5, what: "worker pid 2 is not alive" }, { eventsPath: ev });
    appendEscalation(esc, { now: NOW + 2 * MIN, issue: 5, what: "worker pid 3 is not alive" }, { eventsPath: ev });
    const groups = dedupEscalations(parseEscalations(esc));
    assert.equal(groups.length, 1, "the reader sees one group");
    assert.equal(groups[0].occurrences, 3, "occurrence count reflects every poll");
    assert.equal(groups[0].ts, new Date(NOW + 2 * MIN).toISOString(), "the displayed timestamp is the latest");
    // Resolution logic (0082) still runs over the deduped block without error.
    const resolved = resolveEscalations(groups, { state: {}, closedIssues: new Set() });
    assert.equal(resolved[0].resolved, false, "an open, unacknowledged escalation stays unresolved");
  });
});

// Criterion 6: a malformed or unparseable existing escalations file never crashes
// the writer — the new entry is appended and a warning event is logged.
test("a malformed existing log never crashes the writer: it appends and warns", () => {
  inTemp((dir) => {
    const esc = join(dir, "esc.md");
    const ev = join(dir, "events.jsonl");
    writeFileSync(esc, "%%% not an escalation log %%%\nrandom garbage\n");
    const warnings = [];
    assert.doesNotThrow(() =>
      appendEscalation(esc, { now: NOW, issue: 3, what: "worker pid 1 is not alive" }, { eventsPath: ev, warn: (m) => warnings.push(m) }),
    );
    assert.equal(headings(esc), 1, "the escalation is appended despite the corrupt prefix");
    assert.equal(warnings.length, 1, "exactly one warning is logged for the unparseable file");
    assert.match(warnings[0], /unparseable/i, "the warning names the problem");
  });
});

console.log(`\n${passed} tests passed`);

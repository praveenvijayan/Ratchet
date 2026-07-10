#!/usr/bin/env node
// herd-notify.test.mjs — the acceptance criteria of issue #183 are the test
// plan: exactly one test per criterion of desktop notification on new
// escalation, driven through herd-notify.mjs's public interface. Offline: fake
// exec/log captures, no real osascript. Zero deps. Run:
//   node scripts/herd-notify.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  notificationKey,
  detectNewNotifications,
  notifyDesktop,
  createNotifier,
} from "./herd-notify.mjs";

// A fake exec that records every call and optionally throws. Returns a Promise
// to match the real execFileAsync signature.
function fakeExec({ throw_ = false } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    if (throw_) return Promise.reject(new Error("notifier boom"));
    return Promise.resolve();
  };
  fn.calls = calls;
  return fn;
}

// A fake log that captures every line.
function fakeLog() {
  const lines = [];
  const fn = (...args) => lines.push(args.join(" "));
  fn.lines = lines;
  return fn;
}

// Build an escalation object as readSnapshot would produce it (deduped +
// resolved, with a `reason` field added by dedupEscalations).
function esc(issue, reason, { resolved = false, what = reason } = {}) {
  return { ts: "2026-07-10T12:00:00Z", issue, what, logFile: null, action: "re-queue", reason, occurrences: 1, resolved };
}

// --- #183 Criterion 1: A new unresolved escalation triggers exactly one desktop
// notification naming the issue and reason. -------------------------------
{
  const exec = fakeExec();
  const log = fakeLog();
  const notify = createNotifier({ platform: "darwin", exec, log });

  const escalations = [
    esc(5, "worker pid N is not alive"),
    esc(7, "tracked PR #N is no longer open (merged or closed)"),
    esc(9, "stale claim ref agent/issue-N on origin", { resolved: true }),
  ];
  await notify(escalations);

  // Exactly two notifications fired (issue #5 and #7 are unresolved; #9 is
  // resolved and must not trigger). "Exactly one" per unresolved escalation.
  assert.equal(exec.calls.length, 2, "exactly one osascript call per unresolved escalation");

  // Each notification names the issue and reason.
  const call0 = exec.calls[0].args[1];
  const call1 = exec.calls[1].args[1];
  assert.match(call0, /issue #5/, "the first notification names issue #5 in the title");
  assert.match(call0, /worker pid N is not alive/, "the first notification names the reason in the message body");
  assert.match(call1, /issue #7/, "the second notification names issue #7 in the title");
  assert.match(call1, /no longer open/, "the second notification names the reason in the message body");

  // A resolved escalation never triggers a notification.
  assert.ok(!exec.calls.some((c) => c.args[1].includes("issue #9")), "a resolved escalation does not trigger a notification");

  // detectNewNotifications as a pure function: one fresh unresolved escalation.
  const notifiedSet = new Set();
  const fresh = detectNewNotifications([esc(11, "rework cap reached")], notifiedSet);
  assert.equal(fresh.length, 1, "one new unresolved escalation is detected");
  assert.equal(fresh[0].issue, 11, "the fresh escalation is the one passed in");
  assert.ok(notifiedSet.has(notificationKey(fresh[0])), "the fresh escalation is added to the notified set");
}

// --- #183 Criterion 2: Duplicate occurrences of an already-notified escalation
// (same issue and reason) do not re-notify. --------------------------------
{
  const exec = fakeExec();
  const log = fakeLog();
  const notify = createNotifier({ platform: "darwin", exec, log });

  const e5 = esc(5, "worker pid N is not alive");
  const e7 = esc(7, "tracked PR #N is no longer open (merged or closed)");

  // First poll: both fire.
  await notify([e5, e7]);
  assert.equal(exec.calls.length, 2, "first poll fires one notification per unresolved escalation");

  // Second poll: same escalations — no new notifications.
  await notify([e5, e7]);
  assert.equal(exec.calls.length, 2, "duplicate occurrences of an already-notified escalation do not re-notify");

  // Third poll: a new escalation (different issue + reason) fires, but the
  // already-notified pair still do not.
  const e9 = esc(9, "rework cap reached");
  await notify([e5, e7, e9]);
  assert.equal(exec.calls.length, 3, "only the new escalation triggers a notification; the old pair stay silent");
  assert.match(exec.calls[2].args[1], /issue #9/, "the new escalation's notification names issue #9");

  // Same issue, different reason → a new notification (not a duplicate).
  const e5diff = esc(5, "tracked PR #N is no longer open (merged or closed)");
  await notify([e5, e5diff]);
  assert.equal(exec.calls.length, 4, "same issue with a different reason is a new notification, not a duplicate");
  assert.match(exec.calls[3].args[1], /issue #5/, "the different-reason notification still names the issue");

  // The input array is never mutated.
  const input = [esc(12, "spawn failed")];
  const before = input.length;
  await notify(input);
  assert.equal(input.length, before, "the escalations array is not mutated by notify");
}

// --- #183 Criterion 3: On a platform without a supported notifier, escalations
// still record normally and a one-line hint is logged once, never an error per
// escalation. ---------------------------------------------------------------
{
  const exec = fakeExec();
  const log = fakeLog();
  const notify = createNotifier({ platform: "linux", exec, log });

  const escalations = [
    esc(5, "worker pid N is not alive"),
    esc(7, "tracked PR #N is no longer open (merged or closed)"),
  ];

  // The input array is captured before the call to prove it is unchanged after.
  const snapshot = escalations.slice();
  await notify(escalations);

  // No osascript call on a non-darwin platform.
  assert.equal(exec.calls.length, 0, "no notifier invocation on a platform without a supported notifier");

  // Exactly one hint line, not one per escalation.
  const hints = log.lines.filter((l) => l.includes("herd-notify: desktop notifications require macOS"));
  assert.equal(hints.length, 1, "a single one-line hint is logged, not one per escalation");

  // Escalations still "record normally" — the input array is untouched.
  assert.deepEqual(escalations, snapshot, "escalations still record normally (input unchanged)");

  // A second poll with new escalations does NOT log the hint again.
  await notify([esc(9, "rework cap reached")]);
  const hints2 = log.lines.filter((l) => l.includes("herd-notify: desktop notifications require macOS"));
  assert.equal(hints2.length, 1, "the hint is logged once, never again on subsequent escalations");
  assert.equal(exec.calls.length, 0, "still no notifier invocation on the second poll");

  // notifyDesktop directly: the hint state is honoured.
  const log2 = fakeLog();
  const state = {};
  await notifyDesktop(esc(1, "x"), { platform: "win32", exec, log: log2, state });
  await notifyDesktop(esc(2, "y"), { platform: "win32", exec, log: log2, state });
  const hints3 = log2.lines.filter((l) => l.includes("herd-notify:"));
  assert.equal(hints3.length, 1, "notifyDesktop logs the hint once across multiple calls sharing state");
  assert.equal(exec.calls.length, 0, "notifyDesktop never invokes the notifier on a non-darwin platform");
}

// --- #183 Criterion 4: A failure invoking the notifier is logged and never
// affects the poll or the escalation record. --------------------------------
{
  const exec = fakeExec({ throw_: true });
  const log = fakeLog();
  const notify = createNotifier({ platform: "darwin", exec, log });

  const escalations = [esc(5, "worker pid N is not alive"), esc(7, "tracked PR #N is no longer open (merged or closed)")];
  const snapshot = escalations.map((e) => ({ ...e }));

  // The notify call must not throw — the failure is logged and swallowed.
  await assert.doesNotReject(notify(escalations), "a notifier failure never throws to the caller (the poll)");

  // The failure was logged.
  const failures = log.lines.filter((l) => l.includes("herd-notify: failed to notify"));
  assert.ok(failures.length >= 1, "the notifier failure is logged");
  assert.match(failures[0], /issue #5/, "the failure log names the issue that failed");

  // The escalation record (input array) is untouched.
  assert.deepEqual(escalations, snapshot, "the escalation record is not affected by a notifier failure");

  // A second poll does not re-notify (the escalation was added to the notified
  // set before the exec call, so a transient failure does not cause a retry
  // flood — one log line per escalation, not one per poll).
  const failuresBefore = failures.length;
  await assert.doesNotReject(notify(escalations), "a second poll still does not throw");
  const failuresAfter = log.lines.filter((l) => l.includes("herd-notify: failed to notify")).length;
  assert.equal(failuresAfter, failuresBefore, "a failed notification is not retried on the next poll (no flood)");

  // notifyDesktop directly: never throws.
  const log2 = fakeLog();
  await assert.doesNotReject(
    notifyDesktop(esc(99, "boom"), { platform: "darwin", exec: () => Promise.reject(new Error("direct boom")), log: log2 }),
    "notifyDesktop never throws on an exec failure",
  );
  assert.ok(log2.lines.some((l) => l.includes("herd-notify: failed to notify issue #99")), "notifyDesktop logs the failure with the issue number");
}

// --- #183 Criterion 5: Every criterion above has exactly one test named after
// it. The plan file carried five #183 acceptance criteria; this counts its own
// `#183 Criterion N` markers and proves there is exactly one per criterion,
// 1..5. It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 5;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- #183 Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each #183 criterion is tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per #183 acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `#183 criterion ${n} has a test`);
}

console.log("PASS herd-notify.test.mjs (5 criteria for #183)");

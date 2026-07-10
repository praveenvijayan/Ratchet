#!/usr/bin/env node
// herd-notify.mjs — desktop notifications for new herd escalations. Fires a
// native macOS notification (osascript) when a new unresolved escalation appears
// in the dashboard's snapshot. On other platforms, logs a one-line hint once
// and never fires. All side-effects (exec, log) are injectable so the module
// is fully testable offline. Never throws — a notifier failure is logged and
// swallowed so the dashboard poll and the escalation record are untouched.
//
// The escalation objects consumed here come from readSnapshot() in herd-ui.mjs,
// which already deduplicates (same issue + reason → one block with an occurrence
// count) and resolves (stale-claim with no sentinel, PR-concluded with a closed
// issue → resolved). This module only decides which of those resolved/deduped
// escalations are *new* and *unresolved* and deserve a desktop notification.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Build the stable notification key from an escalation's issue and reason.
// The reason is already normalised by escalationReason() in herd-ui.mjs, so two
// escalations with the same root cause share a key regardless of variable parts
// (pid, PR number, etc.). This is the same key dedupEscalations uses internally.
export function notificationKey(esc) {
  return `${esc.issue}\t${esc.reason}`;
}

// Given escalations (from readSnapshot — already deduped + resolved), return
// those that are unresolved and not yet in notifiedSet. Each returned escalation
// is added to notifiedSet (monotonic — once notified, never again, even if the
// escalation is later resolved and reappears). Pure: does not mutate the input
// array or the escalation objects.
export function detectNewNotifications(escalations, notifiedSet) {
  const fresh = [];
  for (const esc of escalations) {
    if (esc.resolved) continue;
    const key = notificationKey(esc);
    if (notifiedSet.has(key)) continue;
    notifiedSet.add(key);
    fresh.push(esc);
  }
  return fresh;
}

// Escape a string for safe embedding inside an AppleScript double-quoted string.
// Backslashes and double quotes are the only characters that need escaping in
// an AppleScript string literal.
function escapeAppleScript(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Fire one macOS desktop notification naming the issue and reason. On a
// non-darwin platform, logs a single hint line (once per state object) and
// never fires — never an error per escalation. A failure invoking the notifier
// is logged and never thrown, so the caller's poll loop is unaffected.
export async function notifyDesktop(esc, {
  platform = process.platform,
  exec = execFileAsync,
  log = console.log,
  state = {},
} = {}) {
  if (platform !== "darwin") {
    if (!state.hintLogged) {
      state.hintLogged = true;
      log("herd-notify: desktop notifications require macOS; escalations still record normally.");
    }
    return;
  }
  const title = `Herd escalation — issue #${esc.issue}`;
  const message = esc.reason || esc.what || "unresolved escalation";
  try {
    await exec("osascript", ["-e", `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`]);
  } catch (err) {
    log(`herd-notify: failed to notify issue #${esc.issue}: ${err.message}`);
  }
}

// Factory: returns a stateful `notify(escalations)` closure for the dashboard
// tick. Holds the notifiedSet and the hint-logged flag internally so the caller
// just passes the latest escalations array each poll. Never rejects — all
// failures are caught and logged inside notifyDesktop.
export function createNotifier({
  platform = process.platform,
  exec = execFileAsync,
  log = console.log,
} = {}) {
  const notifiedSet = new Set();
  const state = { hintLogged: false };
  return async function notify(escalations) {
    const fresh = detectNewNotifications(escalations, notifiedSet);
    for (const esc of fresh) {
      await notifyDesktop(esc, { platform, exec, log, state });
    }
  };
}

#!/usr/bin/env node
// sweep-lease.test.mjs — the criteria are the test plan. One test per
// acceptance criterion of issue #8, exercised through the public interface
// (the sweep-lease helper the workflow imports) and the shipped AGENTS.md text.
// Zero dependencies. Run:  node scripts/sweep-lease.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HEARTBEAT_MARKER, isHeartbeat, leaseReference, isStale } from "./sweep-lease.mjs";

const HOUR = 3600 * 1000;
const STALE_MS = 2 * HOUR; // matches STALE_HOURS: "2" in the workflow
const now = 100 * HOUR;    // arbitrary fixed "now" (no Date.now needed)

// Criterion 1: AGENTS.md documents a heartbeat an agent performs during long
// builds that renews its lease without pushing code.
{
  const manual = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.ok(manual.includes(HEARTBEAT_MARKER), "AGENTS.md must document the heartbeat marker");
  assert.match(manual, /heartbeat/i, "AGENTS.md must name the heartbeat mechanism");
  assert.match(manual, /without pushing/i, "AGENTS.md must say the heartbeat renews the lease without pushing code");
}

// Criterion 2: a claim with a fresh heartbeat is active and never swept, even
// past STALE_HOURS since the original claim.
{
  assert.ok(isHeartbeat(`still building\n${HEARTBEAT_MARKER}`), "a comment carrying the marker is a heartbeat");
  assert.ok(!isHeartbeat("just a normal comment"), "a plain comment is not a heartbeat");

  const claimAt = now - 5 * HOUR;      // claimed long ago (well past STALE_HOURS)
  const heartbeatAt = now - 10 * 60 * 1000; // beat 10 minutes ago
  const { ref, source } = leaseReference({ claimAt, heartbeatAt, fallbackAt: claimAt });
  assert.equal(source, "heartbeat", "the fresh heartbeat must be the freshness reference");
  assert.equal(isStale(ref, now, STALE_MS), false, "a claim with a fresh heartbeat must not be swept");
}

// Criterion 3: a claim whose heartbeat stopped for more than STALE_HOURS is
// still swept — the crash-recovery path is preserved.
{
  const claimAt = now - 5 * HOUR;
  const heartbeatAt = now - 3 * HOUR;  // last beat 3h ago, > STALE_HOURS
  const { ref } = leaseReference({ claimAt, heartbeatAt, fallbackAt: claimAt });
  assert.equal(isStale(ref, now, STALE_MS), true, "a claim whose heartbeat stopped past STALE_HOURS must still be swept");
}

// Error path (Hard Rule 8): no signs of life at all falls back to the issue's
// own updated_at instead of crashing on undefined timestamps.
{
  const fallbackAt = now - 4 * HOUR;
  const { ref, source } = leaseReference({ fallbackAt });
  assert.equal(source, "issue update", "with no commit/heartbeat/claim, fall back to issue update");
  assert.equal(isStale(ref, now, STALE_MS), true, "the fallback still drives a stale decision cleanly");
}

console.log("PASS sweep-lease.test.mjs (10 assertions)");

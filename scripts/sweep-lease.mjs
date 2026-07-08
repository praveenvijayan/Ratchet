#!/usr/bin/env node
// sweep-lease.mjs — the pure lease-freshness decision for sweep-stale-claims.
// A claim's lease is as fresh as the most recent proof of life: a commit on the
// branch, a heartbeat comment, or the claim event itself. Extracting the
// decision here (imported by the workflow) keeps it unit-testable and is the
// single definition of "is this claim still alive". Zero dependencies.

// The marker that turns an issue comment into a lease heartbeat. An agent
// posts a comment containing this during a long build to renew its lease
// WITHOUT pushing code — proof of life the protocol otherwise can't see,
// because it only pushes once the gates are green.
export const HEARTBEAT_MARKER = "<!-- ratchet-heartbeat -->";

// True iff a comment body is a lease heartbeat.
export function isHeartbeat(body = "") {
  return String(body).includes(HEARTBEAT_MARKER);
}

// Pick the freshest lease reference from every available sign of life. Each
// timestamp is epoch-ms or null. A heartbeat renews the lease exactly as a
// commit does. When nothing is available, fall back to `fallbackAt` (the
// issue's own updated_at). Returns { ref, source } — source names what kept
// the lease alive, for the sweep's comment.
export function leaseReference({ lastCommitAt = null, heartbeatAt = null, claimAt = null, fallbackAt }) {
  const candidates = [
    ["last commit", lastCommitAt],
    ["heartbeat", heartbeatAt],
    ["claim event", claimAt],
  ].filter(([, t]) => typeof t === "number" && !Number.isNaN(t));
  if (candidates.length === 0) return { ref: fallbackAt, source: "issue update" };
  let best = candidates[0];
  for (const c of candidates) if (c[1] > best[1]) best = c;
  return { ref: best[1], source: best[0] };
}

// A lease is stale when its freshest sign of life is at least STALE_MS old.
export function isStale(refMs, nowMs, staleMs) {
  return nowMs - refMs >= staleMs;
}

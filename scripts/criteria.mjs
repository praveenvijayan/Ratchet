#!/usr/bin/env node
// criteria.mjs — the SINGLE definition of "does this body carry acceptance
// criteria", shared by the plan compiler (plan-sync.mjs) and the
// unblock-dependents workflow so both make the same readiness decision. If the
// two ever diverged, unblock-dependents could promote to state:ready an issue
// the compiler would have held as state:draft — the exact bug issue #5 fixes.
// Zero dependencies.

// True iff the body has an `## Acceptance criteria` heading and at least one
// `- [ ]` / `- [x]` checklist item — the readiness rule documented in
// plan/README.md and enforced by plan-sync at creation time.
export function hasAcceptanceCriteria(body = "") {
  const text = String(body);
  const section = /^##\s+Acceptance criteria\s*$/gim.exec(text);
  if (!section) return false;

  const afterHeading = text.slice(section.index + section[0].length);
  const nextPeerSection = afterHeading.search(/^#{1,2}\s+/m);
  const criteriaText = nextPeerSection === -1 ? afterHeading : afterHeading.slice(0, nextPeerSection);
  return /-\s*\[[ x]\]/i.test(criteriaText);
}

// Single source of truth for the `<!-- plan-id: <slug> -->` marker. Every
// consumer (plan-sync, archive, verify) reads and writes the marker through the
// exports below rather than re-deriving a regex — a divergent pattern is exactly
// how issue #345's silent archive skip happened. The pattern tolerates optional
// whitespace around `plan-id:` and the slug so an unusually-spaced marker still
// resolves everywhere.
const PLAN_ID_MARKER_RE = /<!--\s*plan-id:\s*(.+?)\s*-->/;

// The plan-file slug from the marker, or null when the body has no marker
// (e.g. a hand-authored issue).
export function planSlug(body = "") {
  const m = PLAN_ID_MARKER_RE.exec(String(body));
  return m ? m[1] : null;
}

// Render the canonical marker for a slug — the exact string plan-sync appends
// to a compiled issue body.
export function formatPlanMarker(slug) {
  return `<!-- plan-id: ${slug} -->`;
}

// True iff a single line is nothing but a plan-id marker (with optional
// surrounding whitespace). Used to strip the machine-appended marker line from
// a reviewed body without pulling in a second regex definition.
export function isPlanMarkerLine(line = "") {
  return new RegExp(`^\\s*${PLAN_ID_MARKER_RE.source}\\s*$`).test(String(line));
}

// Decide an unblocked issue's post-unblock state and the comment to post.
// Criteria present  -> promote to state:ready.
// Criteria absent   -> hold at state:draft (never expose an unpickable issue as
//                      ready) and name the plan file the human must fix.
export function classifyUnblock(body = "", closedNumber) {
  if (hasAcceptanceCriteria(body)) {
    return {
      state: "state:ready",
      comment: `Unblocked: all blockers closed (#${closedNumber}). Now \`state:ready\`.`,
    };
  }
  const slug = planSlug(body);
  const where = slug ? `\`plan/${slug}.md\`` : "its plan file (no `plan-id` marker found)";
  return {
    state: "state:draft",
    comment:
      `Unblocked: all blockers closed (#${closedNumber}), but this issue has no ` +
      `acceptance criteria, so it stays \`state:draft\` — an agent must never pick ` +
      `an issue with no test plan. Add a \`## Acceptance criteria\` block with at ` +
      `least one \`- [ ]\` item to ${where}, then re-sync.`,
  };
}

// Gate a sweep decision on the issue's live acceptance criteria before it is
// applied. sweep-stale-claims decides to requeue an abandoned claim, but an
// issue whose body lost its criteria (hand-edited after promotion) must not
// re-enter the pickable queue as state:ready — the same guard classifyUnblock
// applies on unblock, reused here so requeue-vs-hold can never diverge from
// what the compiler decided. `decision` is decideSweep's
// { targetState, reason, comment, ... }; `body` is the issue body re-read at
// write time. Only a state:ready outcome is gated — a deliberate non-ready
// target (e.g. state:blocked for merged work awaiting human cleanup) passes
// through untouched. Returns the decision unchanged, or a copy downgraded to
// state:draft with an explanatory comment built from the sweep's diagnostic.
export function classifyRequeue(decision, body = "") {
  if (decision.targetState !== "state:ready" || hasAcceptanceCriteria(body)) {
    return decision;
  }
  const slug = planSlug(body);
  const where = slug ? `\`plan/${slug}.md\`` : "its plan file (no `plan-id` marker found)";
  return {
    ...decision,
    targetState: "state:draft",
    comment:
      `${decision.reason} Its body no longer carries acceptance criteria, so it is ` +
      `held at \`state:draft\` rather than \`state:ready\` — an agent must never pick ` +
      `an issue with no test plan. Restore a \`## Acceptance criteria\` block with at ` +
      `least one \`- [ ]\` item to ${where}, then re-sync.`,
  };
}

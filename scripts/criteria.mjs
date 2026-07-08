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
  return /##\s*Acceptance criteria/i.test(text) && /-\s*\[[ x]\]/i.test(text);
}

// The plan-file slug from the `<!-- plan-id: <slug> -->` marker, or null when
// the body has no marker (e.g. a hand-authored issue).
export function planSlug(body = "") {
  const m = /<!--\s*plan-id:\s*(.+?)\s*-->/.exec(String(body));
  return m ? m[1] : null;
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

#!/usr/bin/env node
// herd-ui-supervisor-heartbeat-dedup.test.mjs — the acceptance criteria of
// issue #332 are the test plan: exactly one test per criterion. The header must
// render exactly one supervisor heartbeat indicator (the dot-based one), the
// text-based "SUPERVISOR LIVE" block must be gone, the poll cadence must remain
// visible exactly once, and the retained indicator must still distinguish the
// not-seen and silent states. Driven through herd-ui.mjs's public interface —
// the served PAGE_HTML. Offline, zero deps. Run:
//   node scripts/herd-ui-supervisor-heartbeat-dedup.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PAGE_HTML } from "./herd-ui.mjs";

// --- #332 criterion 1: the header renders exactly one supervisor heartbeat
// indicator — the dot-based one; the text-based "SUPERVISOR LIVE" block no
// longer appears. ---
{
  // The dot-based indicator (livedot + livetext) is present exactly once.
  const dotMatches = (PAGE_HTML.match(/id="livedot"/g) || []).length;
  assert.equal(dotMatches, 1, "the header has exactly one dot-based indicator (livedot)");
  const textMatches = (PAGE_HTML.match(/id="livetext"/g) || []).length;
  assert.equal(textMatches, 1, "the header has exactly one liveness text span (livetext)");

  // The text-based "SUPERVISOR LIVE" block (hbdetails) is gone entirely.
  assert.doesNotMatch(PAGE_HTML, /id="hbdetails"/, "the text-based supervisor details block is removed");
  assert.doesNotMatch(PAGE_HTML, /id="hbstatus"/, "the supervisor status span is removed");
  assert.doesNotMatch(PAGE_HTML, /id="hbmeta"/, "the supervisor meta span is removed");
  assert.doesNotMatch(PAGE_HTML, /class="supervisor"/, "the supervisor class is removed from the header");
}

// --- #332 criterion 2: the poll cadence ("polls every …") remains visible in
// the header exactly once. ---
{
  const pollMatches = (PAGE_HTML.match(/"polls every " \+ durText\(hb\.pollSeconds\)/g) || []).length;
  assert.equal(pollMatches, 1, "the poll cadence appears exactly once in the rendered header");
}

// --- #332 criterion 3: the retained indicator still distinguishes the
// not-seen and silent states (dot not green, status text says so) as before. ---
{
  // The not-seen state: livetext says "supervisor not seen", dot is NOT green.
  assert.match(PAGE_HTML, /"supervisor not seen"/, "the not-seen state names the supervisor as not seen");
  assert.match(PAGE_HTML, /hb\.lastHeartbeatTs == null[\s\S]*?dot\.classList\.remove\("live"\)/, "the not-seen branch clears the green dot");

  // The silent state: livetext says "supervisor silent", dot is NOT green.
  assert.match(PAGE_HTML, /"supervisor silent · heartbeat " \+ durText\(age\) \+ "s ago"/, "the silent state names the supervisor as silent");
  assert.match(PAGE_HTML, /age > hb\.thresholdSeconds[\s\S]*?dot\.classList\.remove\("live"\)/, "the silent branch clears the green dot");

  // The live state: livetext says "supervisor live", dot IS green.
  assert.match(PAGE_HTML, /"supervisor live · heartbeat " \+ durText\(age\) \+ " ago"/, "the live state names the supervisor as live");
  assert.match(PAGE_HTML, /else\s*\{[\s\S]*?dot\.classList\.add\("live"\)/, "the live branch lights the green dot");
}

// --- #332 criterion 4: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-supervisor-heartbeat-dedup.test.mjs", import.meta.url), "utf8");
  for (const c of ["criterion 1", "criterion 2", "criterion 3", "criterion 4"]) {
    const hits = (self.match(new RegExp(`#332 ${c}:`, "g")) || []).length;
    assert.equal(hits, 1, `#332 ${c} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-supervisor-heartbeat-dedup.test.mjs (4 criteria)");

#!/usr/bin/env node
// herd-ui-combined-cards.test.mjs — the acceptance criteria of issue #319
// (plan 0136, revised: combined character cards, modal log console, routing
// roster, page scroll) are the test plan: exactly one test per criterion,
// driven through herd-ui.mjs's public interface (the exported routingActivity
// projection, a real dashboard server, and the server-rendered PAGE_HTML).
// Criterion 9 (superseded escalations) is tested in
// herd-ui-escalation.test.mjs and criterion 13 (bare gates label) in
// herd-verify.test.mjs — the self-count reads their markers there, so every
// criterion still has exactly one named test. Offline, zero deps. Run:
//   node scripts/herd-ui-combined-cards.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as ui from "./herd-ui.mjs";
import { routingActivity, createDashboardServer, listenOrFail, run, PAGE_HTML } from "./herd-ui.mjs";

// --- test helpers ------------------------------------------------------------

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "combined-cards-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// All state paths anchored in the temp dir so a developer's real .ratchet/
// never leaks into an assertion.
async function withServer(dir, opts, fn) {
  const server = createDashboardServer({
    pollMs: 25,
    statePath: join(dir, ".ratchet", "herd-state.json"),
    eventsPath: join(dir, ".ratchet", "events.jsonl"),
    escalationsPath: join(dir, ".ratchet", "escalations.md"),
    resolutionsPath: join(dir, ".ratchet", "resolutions.jsonl"),
    routingPath: join(dir, ".ratchet", "herd-routing.json"),
    config: { reworkCap: 2, claimTimeoutSeconds: 300 },
    ...opts,
  });
  const port = await listenOrFail(server, 0);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on("error", reject);
  });
}

function writeHerdConfig(dir, obj) {
  mkdirSync(join(dir, ".ratchet"), { recursive: true });
  const path = join(dir, ".ratchet", "herd.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

// The embedded stylesheet — criteria 14/15 assert on the CSS alone, not the
// page's JavaScript (which legitimately contains // comments).
const CSS = /<style>([\s\S]*?)<\/style>/.exec(PAGE_HTML)[1];

// --- #319 criterion 1: a worker whose adapter is on the configured roster
// renders inside its lifecycle group as a single combined mascot-card carrying
// the family label, figure, adapter name, issue link, status chip, title cell,
// telemetry grid, and adapter vitals — no separate deck card, and the card
// moves between groups with its issue. ---
{
  // The combined card is the rostered-adapter branch of rowHtml — the one
  // per-worker renderer inside the lifecycle-group loop — so the card lives in
  // whatever group the worker's issue is in and moves with it.
  assert.ok(PAGE_HTML.includes("(snapshot.deck || []).find((x) => x.name === w.adapter)"), "the card triggers on the worker's adapter being on the deck roster");
  for (const marker of [
    `'<article class="mascot-card' + sel + '" data-issue="' + w.issue`,
    `'<span class="family">' + esc(d.family)`,
    `'<span class="slot-no">' + issueLink(w)`,
    'class="mascot"><img',
    `'<div class="name">' + esc(d.name)`,
    `'<div class="card-chips">' + statusChip`,
    "issueCell(w)",
    'tm("Attempts", attemptsText(w))',
    'vital("Disp.", d.dispatches)',
    'vital("Fail", d.failures)',
    'vital("Launched", d.successes)',
  ]) {
    assert.ok(PAGE_HTML.includes(marker), `the combined card renders ${marker}`);
  }
  // No separate deck card renderer remains: renderDeck maintains header
  // numbers only, and the old #deck grid host is gone from the markup.
  assert.ok(!PAGE_HTML.includes('id="deck"'), "the separate #deck card grid is gone");
}

// --- #319 criterion 2: a worker whose adapter is not on the configured roster
// renders as the plain row card with the same issue link, status chip, title
// cell, and telemetry — never dropped. ---
{
  for (const marker of [
    `'<article class="row' + sel + '" data-issue="'`,
    `'<div class="row-head">' + issueLink(w) + statusChip + who`,
    "issueCell(w) + telemetry",
    `'<span class="who">' + avatarImg(w)`,
  ]) {
    assert.ok(PAGE_HTML.includes(marker), `the plain row renders ${marker}`);
  }
  // Both card shapes stay clickable through the shared data-issue key.
  assert.ok(PAGE_HTML.includes('host.querySelectorAll("[data-issue]")'), "both card shapes select their issue on click");
}

// --- #319 criterion 3: the log console is a modal — #logpane is a <dialog>
// and selecting a card opens it via showModal(), not an always-visible inline
// pane. ---
{
  assert.match(PAGE_HTML, /<dialog class="logpane" id="logpane">/, "#logpane is a <dialog>");
  assert.ok(PAGE_HTML.includes("if (!pane.open) pane.showModal();"), "selecting a card opens the dialog modally");
  assert.ok(!PAGE_HTML.includes('<div class="logpane" id="logpane"'), "the inline log pane markup is gone");
  // The dialog keeps the inner ids the log suites rely on.
  for (const id of ['id="logtitle"', 'id="logsearch"', 'id="lognomatch"', 'id="log"']) {
    assert.ok(PAGE_HTML.includes(id), `the dialog keeps ${id}`);
  }
}

// --- #319 criterion 4: every close path — the #logclose × button, a backdrop
// click, and Esc — routes through one idempotent cleanup that closes the
// dialog, drops the selection, and closes both EventSources. ---
{
  assert.ok(PAGE_HTML.includes("function closeLog()"), "one shared cleanup function exists");
  assert.ok(PAGE_HTML.includes('$("logclose").addEventListener("click", closeLog)'), "the × button routes through the cleanup");
  assert.ok(PAGE_HTML.includes('$("logpane").addEventListener("click", (e) => { if (e.target === $("logpane")) closeLog(); })'), "a backdrop click routes through the cleanup");
  assert.ok(PAGE_HTML.includes('$("logpane").addEventListener("cancel", closeLog)'), "Esc (the dialog cancel event) routes through the cleanup");
  assert.ok(PAGE_HTML.includes('$("logpane").addEventListener("close", closeLog)'), "the dialog close event stays wired as the fallback");
  // The cleanup itself: close the dialog, drop the selection exactly once
  // (idempotence guard), and close both live streams.
  const body = /function closeLog\(\) \{([\s\S]*?)\n  \}/.exec(PAGE_HTML);
  assert.ok(body, "the cleanup body is present");
  assert.ok(body[1].includes("if (pane.open) pane.close();"), "the cleanup closes the dialog");
  assert.ok(body[1].includes("if (selected == null) return;"), "the cleanup is idempotent — a second close is a no-op");
  assert.ok(body[1].includes("selected = null;"), "the cleanup drops the selection");
  assert.ok(body[1].includes("if (logSource) { logSource.close(); logSource = null; }"), "the cleanup closes the log EventSource");
  assert.ok(body[1].includes("if (timelineSource) { timelineSource.close(); timelineSource = null; }"), "the cleanup closes the timeline EventSource");
}

// --- #319 criterion 5: the section header shows "Live Workers" with real
// numbers only — live tally, "N agents" roster, and "max <maxWorkers> live"
// from the snapshot's new maxWorkers field; DECK_CAPACITY and the decorative
// "Bay open" tiles are gone. ---
await inTempDir(async (dir) => {
  assert.ok(PAGE_HTML.includes(">Live Workers<"), "the section is headed Live Workers");
  assert.ok(PAGE_HTML.includes("tallyEl.textContent = String(live.length)"), "the tally counts live workers");
  assert.ok(PAGE_HTML.includes('rosterEl.textContent = String(cards.length) + " agents"'), "the roster reads the configured count as 'N agents'");
  assert.ok(PAGE_HTML.includes('"max " + snapshot.maxWorkers + " live · new agents dock automatically"'), "the note shows the real dispatch cap");
  assert.ok(!("DECK_CAPACITY" in ui), "DECK_CAPACITY is no longer exported");
  assert.ok(!PAGE_HTML.includes("Bay open"), "the decorative Bay open tiles are gone");
  // The snapshot carries the real cap for the note.
  await withServer(dir, { config: { reworkCap: 2, claimTimeoutSeconds: 300, maxWorkers: 3 } }, async (base) => {
    const snap = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.equal(snap.maxWorkers, 3, "the snapshot carries config.maxWorkers");
  });
});

// --- #319 criterion 6: with zero live workers the section shows the friendly
// #deckempty empty-state block instead of a blank grid. ---
{
  assert.match(PAGE_HTML, /<div class="deckempty" id="deckempty" hidden>No live workers right now/, "the friendly empty-state block exists with its message");
  assert.ok(PAGE_HTML.includes("emptyEl.hidden = live.length > 0"), "the empty state shows exactly when nothing is live");
  assert.ok(PAGE_HTML.includes("wrap.hidden = false"), "the section itself stays visible so the empty state can show");
}

// --- #319 criterion 7: the summary strip renders an agent roster tile listing
// every configured adapter, and routingActivity exposes the route, policy,
// next-up adapter (round-robin cursor; first adapter under failover), and last
// dispatch; the next-up agent wears the NEXT chip and the meta line shows the
// last dispatch. ---
{
  const events = [
    { ts: "2026-07-09T10:00:00Z", event: "dispatch", adapter: "a", issue: 7 },
    { ts: "2026-07-09T11:00:00Z", event: "dispatch", adapter: "b", issue: 8 },
  ];
  // Round-robin: the persisted cursor picks the next adapter (modulo, negative-safe).
  const rr = routingActivity({ routing: { default: { adapters: ["a", "b", "c"], policy: "round-robin" } } }, { "routing.default": 4 }, events);
  assert.deepEqual(rr.route, ["a", "b", "c"], "the route lists the configured order");
  assert.equal(rr.policy, "round-robin", "the policy is named");
  assert.equal(rr.nextAdapter, "b", "the round-robin cursor picks the next-up adapter");
  assert.deepEqual({ adapter: rr.lastDispatch.adapter, issue: rr.lastDispatch.issue }, { adapter: "b", issue: 8 }, "the newest dispatch is the last-dispatch meta");
  // Failover: the first adapter is always tried first, cursor irrelevant.
  const fo = routingActivity({ routing: { default: ["a", "b"] } }, { "routing.default": 1 }, []);
  assert.equal(fo.policy, "failover", "an array route defaults to failover");
  assert.equal(fo.nextAdapter, "a", "failover always tries the first adapter first");
  assert.equal(fo.lastDispatch, null, "no dispatch events → no last-dispatch meta");
  // No routing configured → no tile data (the client renders no roster meta).
  assert.equal(routingActivity({}, {}, []), null, "no routing config yields null");
  // The client renders the tile: every configured adapter with image + name,
  // the NEXT chip on the next-up agent, and the last-dispatch meta line.
  assert.ok(PAGE_HTML.includes('class="sumroster"'), "the summary strip carries the roster tile");
  assert.ok(PAGE_HTML.includes("const cards = snapshot.deck || [];"), "the tile lists every configured adapter from the deck roster");
  assert.ok(PAGE_HTML.includes("r && r.nextAdapter === c.name"), "the next-up agent is identified from routingActivity");
  assert.ok(PAGE_HTML.includes('<span class="next-chip">next</span>'), "the next-up agent wears the NEXT chip");
  assert.ok(PAGE_HTML.includes(`last: ' + esc(r.lastDispatch.adapter) + " → #" + esc(r.lastDispatch.issue)`), "the meta line shows the last dispatch");
}

// --- #319 criterion 8: status chips show GitHub's own labels — claim states
// map to state:in-progress, PR-open states to state:in-review, herd-internal
// statuses stay verbatim, and the raw status is preserved in the chip's title
// attribute. ---
{
  const map = /const STATUS_LABEL = \{([\s\S]*?)\};/.exec(PAGE_HTML);
  assert.ok(map, "the status → label map exists");
  for (const claim of ["working", "dispatched", "resumed"]) {
    assert.match(map[1], new RegExp(`"?${claim}"?: "state:in-progress"`), `${claim} maps to state:in-progress`);
  }
  for (const pr of ["awaiting-verification", "ready-for-review", "in-review"]) {
    assert.match(map[1], new RegExp(`"${pr}": "state:in-review"`), `${pr} maps to state:in-review`);
  }
  assert.ok(PAGE_HTML.includes("STATUS_LABEL[s] || s"), "an unmapped herd-internal status stays verbatim");
  assert.ok(PAGE_HTML.includes(`title="' + esc(w.status) + '">' + esc(statusLabel(w.status))`), "the chip shows the label and preserves the raw status in its title");
}

// --- #319 criterion 9 is tested in herd-ui-escalation.test.mjs (superseded
// escalation groups auto-resolve when the issue moved on; recurring problems
// are never hidden) — see the "#319 criterion 9" marker there. ---

// --- #319 criterion 10: the escalations panel renders the newest 10 blocks
// with a "Show N older" toggle that reveals the rest. ---
{
  assert.ok(PAGE_HTML.includes("const MAX_ESC_SHOWN = 10;"), "the panel caps at the newest 10");
  assert.ok(PAGE_HTML.includes("snapshot.escalations.slice(0, MAX_ESC_SHOWN)"), "only the newest blocks render until toggled");
  assert.ok(PAGE_HTML.includes(`"Show " + hidden + " older"`), "the toggle names how many older blocks are hidden");
  assert.ok(PAGE_HTML.includes('onclick="toggleEsc()"'), "the toggle reveals the rest");
  assert.ok(PAGE_HTML.includes('"Show fewer"'), "the expanded panel can collapse again");
}

// --- #319 criterion 11: the adapter breakdown table filters to adapters
// currently in herd.json and heads the spawn-success column "Launched", not
// "OK". ---
await inTempDir(async (dir) => {
  // Events remember a removed adapter ("ghost"); the snapshot must not.
  mkdirSync(join(dir, ".ratchet"), { recursive: true });
  const lines = [
    { ts: "2026-07-09T10:00:00Z", event: "dispatch", adapter: "claude", issue: 1 },
    { ts: "2026-07-09T10:05:00Z", event: "dispatch", adapter: "ghost", issue: 2 },
    { ts: "2026-07-09T10:06:00Z", event: "dispatch", adapter: "ghost", issue: 3, status: "dispatch-failed" },
  ];
  writeFileSync(join(dir, ".ratchet", "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const config = { reworkCap: 2, claimTimeoutSeconds: 300, adapters: { claude: { launch: ["run"] } } };
  await withServer(dir, { config }, async (base) => {
    const snap = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.deepEqual(snap.adapters.map((s) => s.adapter), ["claude"], "the breakdown carries only adapters still in herd.json");
  });
  assert.ok(PAGE_HTML.includes("<th>Launched</th>"), 'the spawn-success column is headed "Launched"');
  assert.ok(!PAGE_HTML.includes("<th>OK</th>"), 'the misleading "OK" heading is gone');
});

// --- #319 criterion 12: config resilience end-to-end — a dashboard started by
// run() re-reads herd.json per snapshot; when the file turns invalid the
// snapshot keeps serving the last good config and carries configError naming
// the exact error, which the page surfaces as the #configbanner banner. ---
await inTempDir(async (dir) => {
  // run() resolves the repo root by walking up to a .git entry, then wires
  // configPath (and routingPath) into the server — the production path this
  // criterion exists to keep alive.
  mkdirSync(join(dir, ".git"));
  writeHerdConfig(dir, { adapters: { claude: { launch: ["run"] } }, routing: { default: "claude" } });
  const { server, port } = await run(["--port", "0"], { log: () => {}, cwd: dir });
  try {
    const base = `http://127.0.0.1:${port}`;
    const before = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.equal(before.configError, null, "a valid herd.json reports no config error");
    assert.deepEqual(before.deck.map((c) => c.name), ["claude"], "the configured roster serves");
    // The file turns invalid: the next snapshot keeps the last good config and
    // names the exact error.
    writeFileSync(join(dir, ".ratchet", "herd.json"), "{ not valid json");
    const after = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.deepEqual(after.deck.map((c) => c.name), ["claude"], "the last good config keeps serving");
    assert.ok(typeof after.configError === "string" && after.configError.length > 0, "the snapshot names the exact config error");
    // Fixing the file clears the banner on the next snapshot.
    writeHerdConfig(dir, { adapters: { claude: { launch: ["run"] } }, routing: { default: "claude" } });
    const fixed = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.equal(fixed.configError, null, "fixing the file clears the error");
  } finally {
    await new Promise((r) => server.close(r));
  }
  // The page surfaces the error as a banner naming the failure.
  assert.ok(PAGE_HTML.includes('id="configbanner"'), "the config banner element exists");
  assert.ok(PAGE_HTML.includes('"herd.json is invalid — running on the last good config. " + snapshot.configError'), "the banner names the exact error");
  assert.ok(PAGE_HTML.includes("if (!snapshot.configError) { el.hidden = true; return; }"), "the banner hides when the config is healthy");
});

// --- #319 criterion 13 is tested in herd-verify.test.mjs (hasGatesSection
// accepts a bare "Gates" / "Gate results:" label line; a word-in-sentence
// mention still does not count) — see the "#319 criterion 13" marker there. ---

// --- #319 criterion 14: on a desktop-width viewport the page scrolls as one
// document — the desktop media query applies no overflow:hidden viewport cap
// to body/main, only the errors panel keeps an internal scroll region, and
// main spans near full viewport width. ---
{
  const desktop = /@media \(min-width:\s*1181px\)\s*\{([\s\S]*?)\n  \}/.exec(CSS);
  assert.ok(desktop, "the desktop media query is present");
  assert.doesNotMatch(desktop[1], /overflow:\s*hidden/i, "no overflow:hidden viewport cap remains on desktop");
  assert.match(desktop[1], /\.errpanel\s*\{[^}]*overflow-y:\s*scroll/i, "only the errors panel keeps an internal scroll region");
  assert.match(CSS, /main\s*\{[^}]*max-width:\s*98%/i, "main spans near full viewport width");
}

// --- #319 criterion 15: the embedded PAGE_HTML stylesheet contains no //
// line comments and no empty placeholder rules. ---
{
  for (const line of CSS.split("\n")) {
    assert.ok(!/^\s*\/\//.test(line), `the stylesheet has no // line comment: ${line.trim()}`);
  }
  assert.doesNotMatch(CSS, /\{\s*\}/, "the stylesheet has no empty placeholder rules");
}

// --- #319 criterion 16: every criterion above has exactly one test named
// after it. Criteria 9 and 13 live with their subjects (the escalation and
// verify suites); their markers are counted in those files so the one-test-
// per-criterion contract holds across the three files. ---
{
  const here = readFileSync(new URL("./herd-ui-combined-cards.test.mjs", import.meta.url), "utf8");
  const esc = readFileSync(new URL("./herd-ui-escalation.test.mjs", import.meta.url), "utf8");
  const verify = readFileSync(new URL("./herd-verify.test.mjs", import.meta.url), "utf8");
  const at = (text, n) => (text.match(new RegExp(`#319 criterion ${n}:`, "g")) || []).length;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 14, 15, 16]) {
    assert.equal(at(here, n), 1, `#319 criterion ${n} has exactly one test in this file`);
  }
  assert.equal(at(esc, 9), 1, "#319 criterion 9 has exactly one test in herd-ui-escalation.test.mjs");
  assert.equal(at(verify, 13), 1, "#319 criterion 13 has exactly one test in herd-verify.test.mjs");
}

console.log("PASS herd-ui-combined-cards.test.mjs (16 criteria for #319; 9 and 13 delegated)");

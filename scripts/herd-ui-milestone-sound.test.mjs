#!/usr/bin/env node
// herd-ui-milestone-sound.test.mjs — the acceptance criteria of issue #454 are
// the test plan: exactly one test per criterion of the herd dashboard's audible
// milestone cues, driven through herd-ui.mjs's public interface. Audio is a
// browser concern, so the client decision logic is proved via its exported data
// (cue table, event identity, ordering) plus the injected page source PAGE_HTML
// — the idiom the other herd-ui tests use — while the new transport (a silent
// `backlog` frame, then live `milestone` frames) is exercised over real HTTP.
// Offline, zero deps. Run: node scripts/herd-ui-milestone-sound.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_HTML, MILESTONE_CUES, eventKey, orderedEvents, createDashboardServer, listenOrFail } from "./herd-ui.mjs";
import { HERD_EVENT_TYPES } from "./herd-survey.mjs";

const MILESTONES = ["dispatch", "claim-detected", "pr-detected", "worker-exit", "escalation"];

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-sound-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// A dashboard server whose only wired data source is an events log; the other
// files point at absent temp paths so nothing leaks in from the repo.
async function withServer(dir, fn) {
  const eventsPath = join(dir, "events.jsonl");
  const server = createDashboardServer({
    pollMs: 15, config: {}, eventsPath,
    statePath: join(dir, "state.json"), escalationsPath: join(dir, "escalations.md"),
    resolutionsPath: join(dir, "resolutions.jsonl"), routingPath: join(dir, "routing.json"),
  });
  const port = await listenOrFail(server, 0);
  try { return await fn(`http://127.0.0.1:${port}`, eventsPath); }
  finally { await new Promise((r) => server.close(r)); }
}

const line = (ts, event, issue) => JSON.stringify(issue == null ? { ts, event } : { ts, event, issue }) + "\n";

// Read an SSE stream into frames ({event, data}); resolves once `want` arrive or
// on timeout. `onFrame` lets a test append after the backlog frame so the next
// poll delivers a live `milestone` frame.
function streamFrames(url, { want = 1, timeoutMs = 3000, onFrame } = {}) {
  return new Promise((resolve) => {
    const frames = [];
    let done = false, req;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { req.destroy(); } catch (e) {} resolve(frames); };
    const timer = setTimeout(finish, timeoutMs);
    req = httpGet(url, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (!raw.trim()) continue;
          const ev = /(?:^|\n)event: *(.*)/.exec(raw), dm = /(?:^|\n)data: *([\s\S]*)/.exec(raw);
          if (!dm) continue;
          frames.push({ event: ev ? ev[1].trim() : "message", data: JSON.parse(dm[1]) });
          if (onFrame) onFrame(frames[frames.length - 1], frames);
          if (frames.length >= want) return finish();
        }
      });
    });
    req.on("error", () => {});
  });
}

const RAN = [];
async function test(name, fn) { await fn(); RAN.push(name); console.log("  ok -", name); }

// --- criterion 1 -------------------------------------------------------------
await test("criterion 1: a dispatch, claim, PR-opened, worker-exit, and escalation event each play a distinct cue", async () => {
  assert.deepEqual(Object.keys(MILESTONE_CUES).sort(), [...MILESTONES].sort(), "the five milestones each have a cue");
  const freqs = Object.values(MILESTONE_CUES).map((c) => c.freq);
  assert.equal(new Set(freqs).size, freqs.length, "the five cues are audibly distinct (distinct frequencies)");
  assert.ok(PAGE_HTML.includes("const cue = MILESTONE_CUES[e && e.event];") && PAGE_HTML.includes("if (cue) playCue(cue);"),
    "the client chimes an event only via its cue-table entry");
  // Transport: each milestone appended live is delivered on a `milestone` frame.
  await inTempDir((dir) => withServer(dir, async (base, eventsPath) => {
    writeFileSync(eventsPath, "");
    const frames = await streamFrames(`${base}/api/events`, {
      want: 2,
      onFrame: (f) => { if (f.event === "backlog") { let t = 1; for (const ev of MILESTONES) appendFileSync(eventsPath, line(`2026-07-16T00:00:0${t++}.000Z`, ev, 400 + t)); } },
    });
    const got = frames.filter((f) => f.event === "milestone").flatMap((f) => f.data).map((e) => e.event);
    for (const ev of MILESTONES) assert.ok(got.includes(ev), `${ev} delivered on a milestone frame`);
  }));
});

// --- criterion 2 -------------------------------------------------------------
await test("criterion 2: every other event type on the stream plays no cue", async () => {
  const others = HERD_EVENT_TYPES.filter((t) => !MILESTONES.includes(t));
  assert.ok(others.length > 0, "there are non-milestone event types");
  for (const t of others) assert.equal(MILESTONE_CUES[t], undefined, `${t} maps to no cue`);
  for (const t of MILESTONES) assert.ok(MILESTONE_CUES[t], `${t} maps to a cue`);
  // The client's only chime path is the cue-table lookup, so a type with no
  // entry (every non-milestone) is silent.
  assert.ok(PAGE_HTML.includes("const cue = MILESTONE_CUES[e && e.event];") && PAGE_HTML.includes("if (cue) playCue(cue);"),
    "no cue entry means no chime");
});

// --- criterion 3 -------------------------------------------------------------
await test("criterion 3: events already present when the page loads (backlog replay) play no cue", async () => {
  assert.ok(PAGE_HTML.includes('soundStream.addEventListener("backlog", (ev) => ingestEvents(JSON.parse(ev.data), false));'),
    "the backlog batch is ingested with live=false");
  assert.ok(PAGE_HTML.includes("if (!live) continue;"), "the backlog path seeds the seen-set but chimes nothing");
  // Transport: whatever history exists on connect arrives as one `backlog`
  // frame (never `milestone`), regardless of how much history there is.
  await inTempDir((dir) => withServer(dir, async (base, eventsPath) => {
    let raw = "";
    for (let i = 0; i < 5; i++) raw += line(`2026-07-15T00:00:0${i}.000Z`, MILESTONES[i], 100 + i);
    writeFileSync(eventsPath, raw);
    const frames = await streamFrames(`${base}/api/events`, { want: 1 });
    assert.equal(frames[0].event, "backlog", "the first frame is the silent backlog replay");
    assert.equal(frames[0].data.length, 5, "the whole existing history replays as backlog");
    assert.ok(!frames.some((f) => f.event === "milestone"), "nothing pre-existing arrives as a live milestone");
  }));
});

// --- criterion 4 -------------------------------------------------------------
await test("criterion 4: a burst plays each cue without overlapping into noise and never plays the same event's cue twice", async () => {
  // No double chime: the client dedupes by stable event identity. Replaying the
  // same identity twice through that logic collapses it to one cue.
  assert.ok(PAGE_HTML.includes("if (cueSeen.has(key)) continue;") && PAGE_HTML.includes("cueSeen.add(key)"), "an already-seen event is skipped");
  const burst = [
    { ts: "2026-07-16T00:00:02.000Z", event: "dispatch", issue: 7 },
    { ts: "2026-07-16T00:00:01.000Z", event: "claim-detected", issue: 7 },
    { ts: "2026-07-16T00:00:02.000Z", event: "dispatch", issue: 7 },
  ];
  const seen = new Set(), chimed = [];
  for (const e of orderedEvents(burst)) { const k = eventKey(e); if (seen.has(k)) continue; seen.add(k); if (MILESTONE_CUES[e.event]) chimed.push(k); }
  assert.equal(chimed.length, 2, "the duplicate event chimes only once");
  // No overlap: a burst is staggered along the audio clock, not all at once.
  assert.ok(PAGE_HTML.includes("const start = Math.max(ctx.currentTime, nextCueAt);") && PAGE_HTML.includes("nextCueAt = start + dur + gap;"),
    "each cue starts after the last queued one");
});

// --- criterion 5 -------------------------------------------------------------
await test("criterion 5: when audio is blocked the dashboard streams normally and shows a one-time hint", async () => {
  assert.ok(/id="soundhint"[^>]*\shidden/.test(PAGE_HTML), "a one-time hint element exists, hidden by default");
  assert.ok(PAGE_HTML.includes("if (audioBlocked) return;"), "the hint fires at most once, never once per event");
  assert.ok(PAGE_HTML.includes("catch (e) { soundHintOnce(); return null; }") && PAGE_HTML.includes("catch (e) { soundHintOnce(); }"),
    "audio failures surface the hint, never a raw error");
  // Audio is a separate EventSource from the state stream, so a blocked/failed
  // audio path cannot stop the dashboard rendering or streaming state.
  assert.ok(PAGE_HTML.includes('new EventSource("/api/stream")') && PAGE_HTML.includes('new EventSource("/api/events")'),
    "state and sound stream independently");
  await inTempDir((dir) => withServer(dir, async (base, eventsPath) => {
    writeFileSync(eventsPath, line("2026-07-16T00:00:01.000Z", "dispatch", 1));
    const page = await new Promise((res) => httpGet(`${base}/`, (r) => { let b = ""; r.setEncoding("utf8"); r.on("data", (c) => (b += c)); r.on("end", () => res({ status: r.statusCode, body: b })); }));
    assert.equal(page.status, 200, "the dashboard renders regardless of audio");
    assert.ok(page.body.includes('id="soundhint"'), "the rendered page carries the hint element");
  }));
});

// --- criterion 6 -------------------------------------------------------------
await test("criterion 6: every criterion above has exactly one test named after it", async () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  // Needle assembled from pieces so this counting line is not itself counted.
  for (let n = 1; n <= 6; n++) {
    const count = src.split('test("criterion ' + n + ":").length - 1;
    assert.equal(count, 1, "criterion " + n + " has exactly one test named after it");
  }
});

assert.equal(RAN.length, 6, "all six criterion tests ran");
assert.equal(new Set(RAN).size, 6, "each test name is unique");
console.log(`PASS herd-ui-milestone-sound.test.mjs (${RAN.length} tests)`);

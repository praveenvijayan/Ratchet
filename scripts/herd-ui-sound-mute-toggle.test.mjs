#!/usr/bin/env node
// herd-ui-sound-mute-toggle.test.mjs — the acceptance criteria of issue #455
// are the test plan: exactly one test per criterion of the herd dashboard's
// persisted mute/volume control for milestone cues, driven through
// herd-ui.mjs's public interface. Audio and localStorage are browser concerns,
// so the client decision logic is proved via its exported twins
// (normalizeSoundPref, isSoundSilent, the key + documented default) plus the
// injected page source PAGE_HTML — the idiom the other herd-ui tests use —
// while the dashboard's continued rendering is exercised over real HTTP.
// Offline, zero deps. Run: node scripts/herd-ui-sound-mute-toggle.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAGE_HTML, SOUND_PREF_KEY, SOUND_PREF_DEFAULT, normalizeSoundPref, isSoundSilent,
  createDashboardServer, listenOrFail,
} from "./herd-ui.mjs";

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herd-mute-"));
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

const getPage = (base) => new Promise((res) =>
  httpGet(`${base}/`, (r) => { let b = ""; r.setEncoding("utf8"); r.on("data", (c) => (b += c)); r.on("end", () => res({ status: r.statusCode, body: b })); }));

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
await test("criterion 1: the dashboard header shows a mute toggle whose icon/label reflect the current state", async () => {
  // The control lives in the header, ahead of <main>.
  const btnAt = PAGE_HTML.indexOf('id="mutebtn"');
  assert.ok(btnAt !== -1, "a mute toggle button exists");
  assert.ok(btnAt < PAGE_HTML.indexOf("<main>"), "the toggle is in the header, not the body");
  assert.ok(PAGE_HTML.includes('id="muteicon"') && PAGE_HTML.includes('id="mutelabel"'), "the toggle carries an icon and a label element");
  // The icon and label are driven from the effective (silent) state, and the
  // button reflects it as aria-pressed — a change of state changes both.
  assert.ok(PAGE_HTML.includes('icon.textContent = silent ? "🔇" : "🔊";'), "the icon reflects the current state");
  assert.ok(PAGE_HTML.includes('label.textContent = silent ? "Muted" : "Sound on";'), "the label reflects the current state");
  assert.ok(PAGE_HTML.includes('btn.setAttribute("aria-pressed", String(silent));'), "the toggle's pressed state reflects the current state");
  assert.ok(PAGE_HTML.includes("const silent = soundSilent();"), "the reflected state is the effective silent state");
  // The rendered page actually serves the control.
  await inTempDir((dir) => withServer(dir, async (base) => {
    const page = await getPage(base);
    assert.equal(page.status, 200, "the dashboard renders");
    assert.ok(page.body.includes('id="mutebtn"') && page.body.includes('id="volslider"'), "the rendered header carries the toggle and volume control");
  }));
});

// --- criterion 2 -------------------------------------------------------------
await test("criterion 2: toggling to muted stops all milestone cues immediately while events keep streaming and rendering", async () => {
  // A muted preference plays nothing: playCue bails before scheduling a cue.
  assert.ok(PAGE_HTML.includes("if (soundSilent()) return; // muted or volume 0: play nothing at all"), "a silent preference plays no cue");
  // Immediacy: muting drops the master gain to zero at the current audio time,
  // which cuts an already-scheduled burst, not just future cues. Every cue is
  // routed through that master gain.
  assert.ok(PAGE_HTML.includes("const g = soundSilent() ? 0 : soundPref.volume;"), "muting maps to zero gain");
  assert.ok(PAGE_HTML.includes("masterGain.gain.setValueAtTime(g, audioCtx.currentTime)"), "the level is applied at the current audio time, cutting in-flight cues");
  assert.ok(PAGE_HTML.includes("osc.connect(gain).connect(masterGain || ctx.destination);"), "cues play through the master gain the mute cuts");
  assert.ok(PAGE_HTML.includes("saveSoundPref(); applySoundLevel(); applyMuteUI();"), "toggling applies the new level immediately");
  // Streaming is unaffected: the sound transport keeps delivering live
  // milestone frames regardless of the client's mute state (mute is client-side
  // only; the server has no notion of it).
  await inTempDir((dir) => withServer(dir, async (base, eventsPath) => {
    writeFileSync(eventsPath, "");
    const frames = await streamFrames(`${base}/api/events`, {
      want: 2,
      onFrame: (f) => { if (f.event === "backlog") appendFileSync(eventsPath, line("2026-07-16T00:00:01.000Z", "dispatch", 42)); },
    });
    const got = frames.filter((f) => f.event === "milestone").flatMap((f) => f.data).map((e) => e.event);
    assert.ok(got.includes("dispatch"), "events keep streaming while cues are silenced");
  }));
});

// --- criterion 3 -------------------------------------------------------------
await test("criterion 3: the mute state and volume level survive a page reload and apply before the first event of the new session plays", async () => {
  // Persistence: both fields are written to and read from the same storage key.
  assert.ok(PAGE_HTML.includes("window.localStorage.setItem(SOUND_PREF_KEY, JSON.stringify(soundPref))"), "the preference is written to storage");
  assert.ok(PAGE_HTML.includes("window.localStorage.getItem(SOUND_PREF_KEY)"), "the preference is read from storage");
  assert.deepEqual(normalizeSoundPref({ muted: true, volume: 0.4 }), { muted: true, volume: 0.4 }, "both fields round-trip through the preference shape");
  // Applies before the first event: the preference is loaded synchronously
  // before the sound EventSource is opened, so a live milestone (which can only
  // arrive on a later tick) already sees the restored setting.
  const loadedAt = PAGE_HTML.indexOf("let soundPref = loadSoundPref();");
  const streamAt = PAGE_HTML.indexOf('new EventSource("/api/events")');
  assert.ok(loadedAt !== -1 && streamAt !== -1, "the preference load and the sound stream both exist");
  assert.ok(loadedAt < streamAt, "the stored preference is loaded before the sound stream opens");
  assert.ok(PAGE_HTML.includes("if (soundSilent()) return;"), "the first cue is gated on the loaded preference");
});

// --- criterion 4 -------------------------------------------------------------
await test("criterion 4: volume set to zero behaves as muted and plays nothing", async () => {
  // Zero volume is silent, exactly like an explicit mute; a positive volume is
  // not — proved through the exported predicate the page inlines.
  assert.equal(isSoundSilent({ muted: false, volume: 0 }), true, "zero volume is silent");
  assert.equal(isSoundSilent({ muted: true, volume: 1 }), true, "an explicit mute is silent");
  assert.equal(isSoundSilent({ muted: false, volume: 0.5 }), false, "a positive volume is not silent");
  // The page's silent predicate treats muted and zero volume identically, and
  // that predicate is what gates every cue.
  assert.ok(PAGE_HTML.includes("const soundSilent = () => soundPref.muted || soundPref.volume <= 0;"), "the client treats zero volume as muted");
  assert.ok(PAGE_HTML.includes("if (soundSilent()) return; // muted or volume 0: play nothing at all"), "zero volume plays nothing");
});

// --- criterion 5 -------------------------------------------------------------
await test("criterion 5: a missing or unreadable stored preference falls back to a documented default and renders normally, never an error", async () => {
  // The documented default is unmuted at full volume, frozen so it can't drift.
  assert.deepEqual({ ...SOUND_PREF_DEFAULT }, { muted: false, volume: 1 }, "the documented default is unmuted at full volume");
  assert.equal(typeof SOUND_PREF_KEY, "string", "the storage key is documented");
  // A missing (null), corrupt (non-object / wrong-typed), or out-of-range value
  // all collapse to the default field by field — none throws.
  assert.deepEqual(normalizeSoundPref(null), { muted: false, volume: 1 }, "a missing value falls back to the default");
  assert.deepEqual(normalizeSoundPref("not json"), { muted: false, volume: 1 }, "a non-object value falls back to the default");
  assert.deepEqual(normalizeSoundPref({ muted: "yes", volume: "loud" }), { muted: false, volume: 1 }, "wrong-typed fields fall back to the default");
  assert.deepEqual(normalizeSoundPref({ muted: true, volume: 9 }), { muted: true, volume: 1 }, "an over-range volume clamps to the maximum");
  assert.deepEqual(normalizeSoundPref({ muted: false, volume: -3 }), { muted: false, volume: 0 }, "a negative volume clamps to zero");
  // The page's loader wraps storage access in try/catch returning the default,
  // so a parse error or a thrown localStorage renders the control, not an error.
  assert.ok(PAGE_HTML.includes("catch (e) { return normalizeSoundPref(null); }"), "an unreadable preference falls back to the default without throwing");
  // The dashboard renders the control regardless (the server holds no pref).
  await inTempDir((dir) => withServer(dir, async (base) => {
    const page = await getPage(base);
    assert.equal(page.status, 200, "the dashboard renders with no stored preference");
    assert.ok(page.body.includes('id="mutebtn"'), "the control renders from the default");
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
console.log(`PASS herd-ui-sound-mute-toggle.test.mjs (${RAN.length} tests)`);

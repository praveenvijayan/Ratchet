#!/usr/bin/env node
// herd-avatar.test.mjs — acceptance criteria for issue #165 (plan
// 0077-herd-adapter-avatar): exactly one test per criterion for the dashboard's
// per-adapter mascot avatars, driven through the public interfaces of
// herd-avatars.mjs (bundled defaults), herd.mjs (config validation), and
// herd-ui.mjs (row derivation + page markup). Criterion 7 closes the loop by
// counting its own sibling tests against the plan file's criteria. Offline, zero
// dependencies. Run: node scripts/herd-avatar.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_AVATARS, defaultAvatarFor } from "./herd-avatars.mjs";
import { normalizeConfig, HerdConfigError } from "./herd.mjs";
import { buildWorkers, PAGE_HTML } from "./herd-ui.mjs";

const NOW = Date.UTC(2026, 6, 10, 12, 0, 0);
const baseConfig = (adapters) => ({ reworkCap: 2, claimTimeoutSeconds: 300, adapters });

// --- Criterion 1: the framework bundles a set of default mascots; a worker row
// whose adapter declares no avatar shows one, and the same adapter always gets
// the same default across restarts. ------------------------------------------
{
  assert.ok(DEFAULT_AVATARS.length >= 2, "the framework bundles a set (more than one) of default mascots");
  for (const uri of DEFAULT_AVATARS)
    assert.match(uri, /^data:image\/svg\+xml,/, "each bundled default is an embedded image");

  // defaultAvatarFor is a pure function of the name (no clock, no randomness),
  // so the mascot an adapter gets is identical this run and every future one.
  assert.equal(defaultAvatarFor("claude"), defaultAvatarFor("claude"), "same adapter → same default across restarts");
  assert.ok(DEFAULT_AVATARS.includes(defaultAvatarFor("claude")), "the chosen default is one of the bundled set");

  const rows = buildWorkers({
    state: { 7: { adapter: "claude", status: "dispatched", attempts: 0 } },
    events: [],
    config: baseConfig({ claude: { launch: ["claude"] } }),
    now: NOW,
  });
  assert.equal(rows[0].avatar, null, "an adapter with no declared avatar carries no explicit avatar");
  assert.equal(rows[0].defaultAvatar, defaultAvatarFor("claude"), "the row shows the adapter's bundled default");
}

// --- Criterion 2: an adapter may declare an optional `avatar`; when set, the
// dashboard renders that image beside the adapter's worker rows. ---------------
{
  const rows = buildWorkers({
    state: { 5: { adapter: "codex", status: "in-review", attempts: 0 } },
    events: [],
    config: baseConfig({ codex: { launch: ["codex"], avatar: "https://example.test/pic.png" } }),
    now: NOW,
  });
  assert.equal(rows[0].avatar, "https://example.test/pic.png", "a declared avatar becomes the row's avatar");
  assert.match(PAGE_HTML, /w\.avatar \|\| w\.defaultAvatar/, "the page renders the declared avatar beside the row");
}

// --- Criterion 3: an empty-string `avatar` behaves exactly like an absent
// field — the bundled default renders, never a broken image. -------------------
{
  const cfg = normalizeConfig({ adapters: { a: { launch: ["a"], avatar: "" } }, routing: { default: "a" } });
  assert.ok(!("avatar" in cfg.adapters.a), "an empty-string avatar is dropped, indistinguishable from absent");

  const rows = buildWorkers({
    state: { 9: { adapter: "a", status: "dispatched", attempts: 0 } },
    events: [],
    config: baseConfig(cfg.adapters),
    now: NOW,
  });
  assert.equal(rows[0].avatar, null, "an empty avatar leaves the row with no explicit avatar");
  assert.equal(rows[0].defaultAvatar, defaultAvatarFor("a"), "the bundled default renders in its place");
}

// --- Criterion 4: avatars render at a fixed dimension so a large source image
// never breaks the row layout. -------------------------------------------------
{
  assert.match(
    PAGE_HTML,
    /img\.avatar\s*\{[^}]*width:\s*20px[^}]*height:\s*20px/,
    "the .avatar rule pins a fixed width and height",
  );
  assert.match(PAGE_HTML, /img\.avatar\s*\{[^}]*object-fit:\s*cover/, "a large source is cropped, not stretched");
}

// --- Criterion 5: an `avatar` that fails to load in the browser falls back to
// the bundled default, never a broken-image icon. -----------------------------
{
  assert.match(PAGE_HTML, /onerror="avatarFallback\(this\)"/, "each avatar image has a load-failure handler");
  assert.match(
    PAGE_HTML,
    /avatarFallback = function \(img\) \{[^}]*img\.src = img\.dataset\.default/,
    "the handler swaps in the bundled default on failure",
  );
  assert.ok(
    DEFAULT_AVATARS.every((u) => u.startsWith("data:")),
    "the fallback target is an embedded image that always loads (never 404s to a broken icon)",
  );
}

// --- Criterion 6: an `avatar` present but not a string exits nonzero at
// config-validation time with a one-line error naming the adapter. -------------
{
  assert.throws(
    () => normalizeConfig({ adapters: { painter: { launch: ["x"], avatar: 123 } }, routing: { default: "painter" } }),
    (e) =>
      e instanceof HerdConfigError &&
      /painter/.test(e.message) &&
      /avatar/.test(e.message) &&
      !/\n/.test(e.message),
    "a non-string avatar throws a one-line HerdConfigError naming the adapter",
  );
  for (const bad of [{}, [], true, null])
    assert.throws(
      () => normalizeConfig({ adapters: { painter: { launch: ["x"], avatar: bad } }, routing: { default: "painter" } }),
      HerdConfigError,
      `avatar ${JSON.stringify(bad)} is rejected`,
    );
}

// --- Criterion 7: every criterion above has exactly one test named after it. --
// The plan file carries seven acceptance criteria; this counts its own
// `Criterion N` markers and proves there is exactly one per criterion, 1..7.
// It counts markers in THIS file only — it never reads the plan file at
// runtime, so archiving the plan when the issue closes can never break it.
{
  const CRITERIA_COUNT = 7;
  const selfText = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const markers = [...selfText.matchAll(/^\/\/ --- Criterion (\d+):/gim)].map((m) => Number(m[1]));
  const unique = new Set(markers);
  assert.equal(markers.length, unique.size, "each criterion tested exactly once (no duplicate markers)");
  assert.equal(markers.length, CRITERIA_COUNT, `one test per acceptance criterion (${CRITERIA_COUNT})`);
  for (let n = 1; n <= CRITERIA_COUNT; n++) assert.ok(unique.has(n), `criterion ${n} has a test`);
}

console.log("PASS herd-avatar.test.mjs (7 criteria)");

#!/usr/bin/env node
// herd-ui-vinyl-deck.test.mjs — the acceptance criteria of issue #289 (plan
// 0127-herd-deck-vinyl-figure-popout) are the test plan: exactly one test per
// criterion of the vinyl-figure mascot deck revision, plus the plan's Test
// notes (config pinning, path traversal) and Non-functional (framework purity,
// browser caching) sections. Driven through herd-ui.mjs's public interface
// (the pure `buildDeck` / `resolveAvatarUrl` projections, the exported
// `serveMascotImage` route handler, the server-rendered `PAGE_HTML`). Offline,
// zero deps. Run:
//   node scripts/herd-ui-vinyl-deck.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDeck, resolveAvatarUrl, serveMascotImage, PAGE_HTML, MASCOT_ROUTE, createDashboardServer, listenOrFail } from "./herd-ui.mjs";
import { defaultAvatarFor } from "./herd-avatars.mjs";

// --- test helpers ------------------------------------------------------------

async function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vinyl-deck-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A fake PNG body (the 8-byte PNG signature) — enough to test the route serves
// binary bytes without shipping real art into the test fixtures.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Boot a server on an ephemeral port with a temp mascotsDir, hand its base URL
// to `fn`, then tear it down.
async function withServer(opts, fn) {
  const server = createDashboardServer({ pollMs: 25, config: { reworkCap: 2, claimTimeoutSeconds: 300 }, ...opts });
  const port = await listenOrFail(server, 0);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// Fetch a URL returning the raw status, headers, and body as a Buffer (binary-
// safe, unlike the utf8 helper in the main herd-ui test).
function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

// A mock (req, res) pair for testing serveMascotImage in isolation. The URL is
// built as a URL object so pathname and searchParams are available.
function mockReqRes(pathname) {
  const req = { method: "GET" };
  const res = {
    code: null,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(code, headers) { this.code = code; this.headers = {}; for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v; },
    end(data) { if (data != null) this.body = Buffer.isBuffer(data) ? data : Buffer.from(data); },
  };
  const url = new URL(pathname, "http://localhost");
  return { req, res, url };
}

// --- #289 Criterion 1: the six figure PNGs are tracked under root mascots/
// and the dashboard serves them over HTTP, so a card's <img> loads each figure
// by direct URL (no base64/data-URI for the photographic art). ---
{
  // The repo tracks six figure PNGs under mascots/ at the repo root.
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const mascotFiles = ["fig-goggles.png", "fig-hero.png", "fig-labcoat.png", "fig-tropical.png", "fig-varsity.png", "fig-suit.png"];
  for (const f of mascotFiles)
    assert.ok(existsSync(join(repoRoot, "mascots", f)), `mascots/${f} is tracked in the repo`);

  // The dashboard serves a file from mascotsDir over HTTP with the correct
  // content-type and a cache header (non-functional: browser caching), returning
  // the raw image bytes — not a base64/data-URI string.
  await inTempDir(async (dir) => {
    const mascotsDir = join(dir, "mascots");
    mkdirSync(mascotsDir);
    writeFileSync(join(mascotsDir, "fig-goggles.png"), PNG_BYTES);
    await withServer({ mascotsDir }, async (base) => {
      const r = await fetchRaw(base + "/mascots/fig-goggles.png");
      assert.equal(r.status, 200, "the image route serves the file");
      assert.equal(r.headers["content-type"], "image/png", "the content-type is image/png");
      assert.ok(r.headers["cache-control"], "the route sets a cache-control header for browser caching");
      assert.deepEqual(r.body, PNG_BYTES, "the route returns the raw image bytes, not a data URI");
    });
  });
}

// --- #289 Criterion 2: an adapter's avatar in .ratchet/herd.json accepts a
// repo-local image path (e.g. mascots/fig-goggles.png) or a remote URL, and
// the deck card renders it. ---
{
  const config = {
    adapters: {
      "claude-opus": { launch: ["x"], avatar: "mascots/fig-goggles.png" },
      codex: { launch: ["y"], avatar: "https://host/codex.png" },
      "bare-adapter": { launch: ["z"], avatar: "fig-hero.png" },
    },
  };
  const deck = buildDeck({ config });
  const byName = Object.fromEntries(deck.map((c) => [c.name, c]));
  // A repo-local path with the mascots/ prefix resolves to the served URL.
  assert.equal(byName["claude-opus"].avatar, "/mascots/fig-goggles.png", "a mascots/ path resolves to the served URL");
  // A bare filename also resolves to the served URL (basename extraction).
  assert.equal(byName["bare-adapter"].avatar, "/mascots/fig-hero.png", "a bare filename resolves to the served URL");
  // A remote URL passes through unchanged.
  assert.equal(byName.codex.avatar, "https://host/codex.png", "a remote URL passes through unchanged");
  // The renderDeck HTML uses the resolved avatar as the <img> src.
  assert.ok(PAGE_HTML.includes("c.avatar || c.defaultAvatar"), "the deck card renders the avatar as the img src");
}

// --- #289 Criterion 3: deck cards render the figure anchored to the card's
// 132×126 mascot slot, drawn ~192px tall so it overflows above the card's top
// border, unclipped, layered over the card border and dashed inner frame. ---
{
  // The slot is 132×126, the image is 192px tall and absolutely positioned at
  // the bottom, so ~60px overflows above the card's top border.
  assert.match(PAGE_HTML, /\.mascot\s*\{[^}]*position:relative[^}]*width:132px[^}]*height:126px/, "the mascot slot is 132×126 with position:relative");
  assert.match(PAGE_HTML, /\.mascot img\s*\{[^}]*position:absolute[^}]*left:50%[^}]*bottom:0[^}]*height:192px/, "the figure is absolutely positioned, 192px tall, anchored to the bottom");
  // z-index:3 on the image puts it over the card border (z auto) and the dashed
  // inner frame (::before at z-index:1).
  assert.match(PAGE_HTML, /\.mascot img\s*\{[^}]*z-index:3/, "the figure is z-index:3, above the card border and dashed frame");
  assert.match(PAGE_HTML, /\.mascot-card::before\s*\{[^}]*z-index:1/, "the dashed inner frame is z-index:1, below the figure");
  // The card must not clip the overflowing figure.
  assert.ok(!/\.mascot-card\s*\{[^}]*overflow:\s*hidden/.test(PAGE_HTML), "the card does not clip the overflowing figure");
}

// --- #289 Criterion 4: the figure carries the soft 3D drop-shadow pair and
// the 96×16 elliptical contact shadow at its feet, per the handoff spec. ---
{
  // The soft 3D drop-shadow pair on the figure image.
  assert.match(
    PAGE_HTML,
    /\.mascot img\s*\{[^}]*filter:drop-shadow\(0 12px 10px rgba\(31,41,51,\.30\)\) drop-shadow\(0 3px 3px rgba\(31,41,51,\.18\)\)/,
    "the figure carries the soft 3D drop-shadow pair",
  );
  // The 96×16 elliptical contact shadow at the feet via .mascot::after.
  assert.match(PAGE_HTML, /\.mascot::after\s*\{[^}]*width:96px[^}]*height:16px[^}]*border-radius:50%/, "the contact shadow is a 96×16 ellipse");
  assert.match(PAGE_HTML, /\.mascot::after\s*\{[^}]*radial-gradient\(closest-side/, "the contact shadow uses a radial gradient");
  assert.match(PAGE_HTML, /\.mascot::after\s*\{[^}]*bottom:-6px/, "the contact shadow sits just below the slot");
}

// --- #289 Criterion 5: hovering the card lifts the figure (translateY(-7px)
// scale(1.05)) with the deeper drop-shadow, transitioning ~.22s ease, alongside
// the existing card lift. ---
{
  // The hover lifts the figure with the exact transform and deeper shadow.
  assert.match(
    PAGE_HTML,
    /\.mascot-card:hover \.mascot img\s*\{[^}]*transform:translateX\(-50%\) translateY\(-7px\) scale\(1\.05\)/,
    "hover lifts the figure translateY(-7px) scale(1.05)",
  );
  assert.match(
    PAGE_HTML,
    /\.mascot-card:hover \.mascot img\s*\{[^}]*filter:drop-shadow\(0 20px 16px rgba\(31,41,51,\.32\)\) drop-shadow\(0 4px 4px rgba\(31,41,51,\.16\)\)/,
    "hover applies the deeper drop-shadow pair",
  );
  // The transition is ~.22s ease on transform and filter.
  assert.match(PAGE_HTML, /\.mascot img\s*\{[^}]*transition:transform \.22s ease, filter \.22s ease/, "the figure transitions transform and filter at .22s ease");
  // The existing card lift is preserved alongside.
  assert.match(PAGE_HTML, /\.mascot-card:hover\s*\{[^}]*transform:translateY\(-4px\)/, "the existing card lift is preserved");
}

// --- #289 Criterion 6: the card grid keeps the 52px top padding and 72px row
// gap so overflowing figures never collide with the section header or the row
// of cards above (revised by #319: the grid is the .rows grid inside each
// lifecycle group — the separate .deck grid is gone). ---
{
  assert.match(PAGE_HTML, /\.rows\s*\{[^}]*padding-top:52px/, "the card grid has 52px top padding for headroom");
  assert.match(PAGE_HTML, /\.rows\s*\{[^}]*row-gap:72px/, "the card grid has 72px row gap so rows don't collide");
}

// --- #289 Criterion 7: a missing or failing image (deleted file, bad path,
// unreachable remote URL) falls back to the bundled default mascot — a
// broken-image icon is never shown. ---
{
  const config = {
    adapters: {
      "a-missing": { launch: ["x"], avatar: "mascots/nonexistent.png" },
      "b-remote": { launch: ["y"], avatar: "https://unreachable.host/x.png" },
      "c-noavatar": { launch: ["z"] },
    },
  };
  const deck = buildDeck({ config });
  const byName = Object.fromEntries(deck.map((c) => [c.name, c]));
  // Every card carries a bundled default that is always a valid data URI — it
  // is the load-failure fallback and never 404s. (Non-functional: the framework
  // keeps its bundled data-URI defaults as the fallback.)
  for (const c of deck)
    assert.ok(c.defaultAvatar.startsWith("data:image/svg+xml,"), `${c.name} carries a bundled data-URI default as fallback`);
  // A local-path avatar is still resolved to a URL even when the file is
  // missing — the browser's onerror handler does the fallback, not the server.
  assert.equal(byName["a-missing"].avatar, "/mascots/nonexistent.png", "a missing local path still resolves to a URL (browser fallback handles the 404)");
  // The onerror fallback is wired on the mascot <img>.
  assert.ok(PAGE_HTML.includes('onerror="avatarFallback(this)"'), "the mascot img has the onerror fallback handler");
  assert.ok(PAGE_HTML.includes("avatarFallback"), "the avatarFallback function is defined");
}

// --- #289 Criterion 8: the dashboard's image route never serves files outside
// the repo's image location — a path-traversal request gets a 404, not file
// contents. ---
{
  await inTempDir(async (dir) => {
    const mascotsDir = join(dir, "mascots");
    mkdirSync(mascotsDir);
    writeFileSync(join(mascotsDir, "fig-goggles.png"), PNG_BYTES);
    // A sensitive file outside mascots/ that a traversal would reach.
    writeFileSync(join(dir, "secret.txt"), "TOPSECRET");
    mkdirSync(join(dir, ".ratchet"));
    writeFileSync(join(dir, ".ratchet", "herd.json"), '{"adapters":{}}');

    // Direct path-traversal attempts via the HTTP route all get 404.
    await withServer({ mascotsDir }, async (base) => {
      const attempts = [
        "/mascots/../secret.txt",
        "/mascots/../../secret.txt",
        "/mascots/..%2fsecret.txt",
        "/mascots/..%2F.ratchet%2Fherd.json",
        "/mascots/%2e%2e/secret.txt",
        "/mascots/",
        "/mascots/sub/../../secret.txt",
      ];
      for (const path of attempts) {
        const r = await fetchRaw(base + path);
        assert.equal(r.status, 404, `path-traversal attempt "${path}" gets a 404`);
        assert.ok(!r.body.includes("TOPSECRET"), `path-traversal attempt "${path}" never serves outside contents`);
      }
      // A legitimate file still serves.
      const ok = await fetchRaw(base + "/mascots/fig-goggles.png");
      assert.equal(ok.status, 200, "a legitimate file still serves after traversal rejection");
    });
  });
}

// --- #289 Test notes: config pinning — a local-path avatar wins over the
// bundled default; an unknown/missing path falls back to the bundled default
// rather than breaking the card. ---
{
  // resolveAvatarUrl is the pure resolver: a local path wins (non-null URL),
  // a remote URL passes through, null/empty yields null (default renders).
  assert.equal(resolveAvatarUrl("mascots/fig-goggles.png"), "/mascots/fig-goggles.png", "a local path wins over the default (non-null)");
  assert.equal(resolveAvatarUrl("fig-hero.png"), "/mascots/fig-hero.png", "a bare local filename resolves");
  assert.equal(resolveAvatarUrl("https://host/x.png"), "https://host/x.png", "a remote URL passes through");
  assert.equal(resolveAvatarUrl("data:image/svg+xml,%3Csvg/%3E"), "data:image/svg+xml,%3Csvg/%3E", "a data URI passes through");
  assert.equal(resolveAvatarUrl(null), null, "a null avatar stays null so the default renders");
  assert.equal(resolveAvatarUrl(""), null, "an empty avatar stays null so the default renders");

  // An unknown/missing path still resolves to a URL — the card's onerror
  // handler falls back to the bundled default rather than breaking the card.
  const config = { adapters: { unknown: { launch: ["x"], avatar: "mascots/does-not-exist.png" } } };
  const deck = buildDeck({ config });
  assert.equal(deck[0].avatar, "/mascots/does-not-exist.png", "an unknown path still resolves to a URL");
  assert.ok(deck[0].defaultAvatar.startsWith("data:"), "the bundled default is the fallback target");
  // The HTTP route returns 404 for the missing file — the browser falls back.
  await inTempDir(async (dir) => {
    const mascotsDir = join(dir, "mascots");
    mkdirSync(mascotsDir);
    await withServer({ mascotsDir }, async (base) => {
      const r = await fetchRaw(base + "/mascots/does-not-exist.png");
      assert.equal(r.status, 404, "a missing file gets a 404 — the browser onerror handles the fallback");
    });
  });
}

// --- #289 Test notes: path traversal — the static image route rejects escapes
// from the served directory. ---
{
  await inTempDir(async (dir) => {
    const mascotsDir = join(dir, "mascots");
    mkdirSync(mascotsDir);
    writeFileSync(join(mascotsDir, "real.png"), PNG_BYTES);
    // A symlink inside mascots/ pointing outside the directory.
    try {
      symlinkSync(join(dir, "secret.txt"), join(mascotsDir, "escape.png"));
      writeFileSync(join(dir, "secret.txt"), "TOPSECRET");
    } catch {
      // symlinks may be unavailable on some platforms; skip this assertion
    }

    // The exported serveMascotImage rejects escapes in isolation.
    const mock = mockReqRes("/mascots/../secret.txt");
    serveMascotImage(mock.req, mock.res, mascotsDir, mock.url);
    assert.equal(mock.res.code, 404, "serveMascotImage rejects a parent-directory escape");

    const mockAbs = mockReqRes("/mascots//etc/passwd");
    serveMascotImage(mockAbs.req, mockAbs.res, mascotsDir, mockAbs.url);
    assert.equal(mockAbs.res.code, 404, "serveMascotImage rejects an absolute-path escape");

    const mockEmpty = mockReqRes("/mascots/");
    serveMascotImage(mockEmpty.req, mockEmpty.res, mascotsDir, mockEmpty.url);
    assert.equal(mockEmpty.res.code, 404, "serveMascotImage rejects an empty filename");

    // A legitimate file serves.
    const mockOk = mockReqRes("/mascots/real.png");
    serveMascotImage(mockOk.req, mockOk.res, mascotsDir, mockOk.url);
    assert.equal(mockOk.res.code, 200, "a legitimate file serves via serveMascotImage");
    assert.equal(mockOk.res.headers["content-type"], "image/png", "the content-type is correct");

    // A missing mascotsDir (null) yields 404, never a crash.
    const mockNoDir = mockReqRes("/mascots/real.png");
    serveMascotImage(mockNoDir.req, mockNoDir.res, null, mockNoDir.url);
    assert.equal(mockNoDir.res.code, 404, "a null mascotsDir yields 404, not a crash");
  });
}

// --- #289 Non-functional: framework-purity — the framework code still names no
// CLI, model, or vendor, and keeps its bundled data-URI defaults as the
// fallback; the photographic art and its adapter mapping belong to the host
// repo (files + config), never the framework. ---
{
  const src = readFileSync(new URL("./herd-ui.mjs", import.meta.url), "utf8");
  // Scope to the new code this revision adds: resolveAvatarUrl, MASCOT_ROUTE,
  // serveMascotImage, IMAGE_CONTENT_TYPES. The banned tokens mirror the
  // herd.mjs purity test — "mascots" and "fig-*" are host-repo art filenames
  // (config + files), not CLI/model/vendor names.
  const newCode = src.slice(src.indexOf("export const MASCOT_ROUTE"), src.indexOf("export function buildDeck"));
  const BANNED = [
    "tmux", "zellij", "wezterm", "\\bscreen\\b",
    "opus", "sonnet", "haiku", "gpt-3", "gpt-4", "gpt-5", "davinci", "gemini", "llama", "mistral",
    "litellm", "openrouter", "rtk",
  ];
  for (const token of BANNED)
    assert.ok(!new RegExp(token, "i").test(newCode), `herd-ui.mjs new code must stay framework-pure: it references "${token}"`);
  // The framework keeps its bundled data-URI defaults as the fallback.
  assert.ok(typeof defaultAvatarFor === "function", "the bundled default mascot resolver is exported");
  assert.ok(defaultAvatarFor("any-adapter").startsWith("data:"), "the bundled default is always a data URI (never 404s)");
}

// --- #289 Non-functional: figures load once per page via normal browser caching
// — live-stream updates must not re-transmit or re-fetch the art. ---
{
  // The snapshot carries avatar as a URL string (not the image data), so SSE
  // pushes never re-transmit the photographic art — the browser fetches it once
  // via the URL and caches it.
  const config = { adapters: { "claude-opus": { launch: ["x"], avatar: "mascots/fig-goggles.png" } } };
  const deck = buildDeck({ config });
  assert.equal(typeof deck[0].avatar, "string", "the avatar is a URL string, not image data");
  assert.ok(!deck[0].avatar.startsWith("data:image/png"), "a local-path avatar is a served URL, not an inlined data URI");
  // The image route sets a cache-control header so the browser caches the art.
  await inTempDir(async (dir) => {
    const mascotsDir = join(dir, "mascots");
    mkdirSync(mascotsDir);
    writeFileSync(join(mascotsDir, "fig-goggles.png"), PNG_BYTES);
    await withServer({ mascotsDir }, async (base) => {
      const r = await fetchRaw(base + "/mascots/fig-goggles.png");
      assert.ok(r.headers["cache-control"], "the route sets cache-control for browser caching");
    });
  });
}

// --- #289: every criterion above has exactly one test named after it. The plan
// carries 8 acceptance criteria, 2 Test notes, and 2 Non-functional requirements
// — this counts its own `Criterion N` / `Test notes` / `Non-functional` markers
// and proves each has exactly one test. It counts markers in THIS file only. ---
{
  const self = readFileSync(new URL("./herd-ui-vinyl-deck.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 8; i++) {
    const hits = (self.match(new RegExp(`#289 Criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `criterion ${i} must have exactly one test named after it`);
  }
  // String concatenation keeps the pattern from matching itself in the source.
  const tnRe = new RegExp("#289 Test notes" + ":", "g");
  assert.equal((self.match(tnRe) || []).length, 2, "the two Test notes each have exactly one test");
  const nfRe = new RegExp("#289 Non-functional" + ":", "g");
  assert.equal((self.match(nfRe) || []).length, 2, "the two Non-functional requirements each have exactly one test");
}

console.log("PASS herd-ui-vinyl-deck.test.mjs (8 criteria + 2 test notes + 2 non-functional)");

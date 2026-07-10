#!/usr/bin/env node
// herd-avatars.mjs — the bundled default mascot images the dashboard shows
// beside every worker row. Adapters are otherwise distinguished only by name
// text, so a fleet with several adapters is hard to scan at a glance; a stable
// per-adapter mascot gives each one a face. The images ship IN the framework
// (this file), so `/ratchet-update` carries them to every consuming repo — no
// asset directory to sync, no network fetch, no external host.
//
// Each mascot is a tiny inline SVG rendered to a `data:` URI, so it is embedded
// in the page and can never 404: it is the always-available fallback when an
// adapter's own `avatar` (a URL or local path) fails to load in the browser.
// These are generic characters — they name no CLI, model, or vendor, so the
// framework-purity rule stays satisfied.

// A small, visually distinct set. Same simple face, different palette and one
// feature per critter, so adapters are told apart at a glance. viewBox 64×64;
// the dashboard renders them at a fixed pixel size regardless of source size.
const MASCOT_SVGS = Object.freeze([
  // teal round
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#2bb3a3"/><circle cx="23" cy="28" r="4" fill="#0d2b28"/><circle cx="41" cy="28" r="4" fill="#0d2b28"/><path d="M22 42 q10 8 20 0" stroke="#0d2b28" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
  // amber, with antenna
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><line x1="32" y1="10" x2="32" y2="2" stroke="#b35900" stroke-width="3"/><circle cx="32" cy="2" r="3" fill="#b35900"/><circle cx="32" cy="34" r="28" fill="#f0a02b"/><circle cx="24" cy="30" r="4" fill="#3a2500"/><circle cx="40" cy="30" r="4" fill="#3a2500"/><path d="M24 44 h16" stroke="#3a2500" stroke-width="3" stroke-linecap="round"/></svg>`,
  // violet, with ears
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M14 20 l6 -12 8 8 z" fill="#7c5cff"/><path d="M50 20 l-6 -12 -8 8 z" fill="#7c5cff"/><circle cx="32" cy="34" r="26" fill="#8a6dff"/><circle cx="24" cy="32" r="4" fill="#1b0f45"/><circle cx="40" cy="32" r="4" fill="#1b0f45"/><circle cx="32" cy="42" r="3" fill="#1b0f45"/></svg>`,
  // rose, sleepy
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#e8557f"/><path d="M18 28 q5 5 10 0" stroke="#3a0a1c" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M36 28 q5 5 10 0" stroke="#3a0a1c" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="32" cy="44" r="4" fill="#3a0a1c"/></svg>`,
  // green, square
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="6" y="6" width="52" height="52" rx="14" fill="#3fa34d"/><circle cx="24" cy="28" r="4" fill="#0b2410"/><circle cx="40" cy="28" r="4" fill="#0b2410"/><path d="M22 40 q10 10 20 0" stroke="#0b2410" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
  // blue, wink
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#3a86ff"/><circle cx="23" cy="28" r="4" fill="#08214d"/><path d="M37 28 h8" stroke="#08214d" stroke-width="3" stroke-linecap="round"/><path d="M24 42 q8 6 16 0" stroke="#08214d" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
]);

// Render one SVG string to a `data:` URI. encodeURIComponent keeps the result
// free of quotes and angle brackets, so it drops straight into an HTML
// attribute without further escaping and never trips the page's markup.
function svgDataUri(svg) {
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// The bundled defaults as ready-to-use image sources. A worker row with no
// adapter avatar renders one of these directly.
export const DEFAULT_AVATARS = Object.freeze(MASCOT_SVGS.map(svgDataUri));

// Deterministic, order-independent hash of an adapter name (FNV-1a, 32-bit).
// Pure: the same name always yields the same number, in this process and every
// future one, so the mascot an adapter gets is stable across dashboard
// restarts. A null/empty name hashes to 0 (the first mascot).
export function hashAdapterName(name) {
  const s = typeof name === "string" ? name : "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The bundled default mascot for an adapter, chosen deterministically from its
// name. Same adapter → same mascot, every run; different adapters spread across
// the set. Never throws and always returns a valid data URI, so it is a safe
// fallback for any name (including null/unknown).
export function defaultAvatarFor(name) {
  return DEFAULT_AVATARS[hashAdapterName(name) % DEFAULT_AVATARS.length];
}

#!/usr/bin/env node
// herd-adapters.mjs — the adapter-resolution leaf of the herd module graph.
//
// `resolveAdapter`, `substitute`, `extractUsage` (and the helpers/constants they
// alone need) live here, not in `herd.mjs`: only the profile modules
// (herd-dispatch/-monitor/-verify/-review) consume them, so a leaf importing
// NOTHING from herd.mjs gives them an import target outside the herd.mjs ⇄
// profile cycle (issue #393, prep for the 0164 cycle-break). herd.mjs re-exports
// every name below, so importers are unchanged. Never import herd.mjs here — that
// is the point of the split. Zero deps (node builtins), Node 20+.

import { accessSync, constants as fsConstants } from "node:fs";
import { join, delimiter as pathDelimiter } from "node:path";

// Multi-adapter route policy: `failover` = first available wins.
export const DEFAULT_POLICY = "failover";

// The three usage numbers extracted from an adapter's log via its `usage` mapping.
export const USAGE_FIELDS = Object.freeze(["costUsd", "tokensIn", "tokensOut"]);

// Substitute ONLY {prompt}, {issue}, and {model}; every other brace token passes
// through byte-for-byte. String or command array; an unsupplied key stays verbatim.
export function substitute(template, vars = {}) {
  const render = (s) =>
    String(s).replace(/\{(prompt|issue|model)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined ? String(vars[key]) : whole,
    );
  return Array.isArray(template) ? template.map(render) : render(template);
}

// Extract an adapter's usage numbers from its log via its `usage` mapping (each
// field a regex whose first group is the number). Pure and total: an invalid,
// non-matching, or non-numeric pattern resolves to null and is named in
// `unresolved`, so the worker-exit path never throws.
export function extractUsage(usage, logText) {
  const text = typeof logText === "string" ? logText : "";
  const values = {};
  const unresolved = [];
  for (const field of USAGE_FIELDS) {
    const pattern = usage && usage[field];
    let value = null;
    if (typeof pattern === "string" && pattern !== "") {
      try {
        const m = new RegExp(pattern).exec(text);
        if (m && m[1] !== undefined) {
          const n = Number(m[1]);
          if (Number.isFinite(n)) value = n;
        }
      } catch {
        // Invalid regex slipped past config validation — treat as unresolved.
      }
    }
    values[field] = value;
    if (value === null) unresolved.push(field);
  }
  return { values, unresolved };
}

// Does `exe` resolve to an executable file? A path-bearing exe is checked
// directly; a bare name is searched across PATH. Injectable for offline tests.
export function executableOnPath(exe, env = process.env) {
  if (typeof exe !== "string" || exe === "") return false;
  const isExec = (p) => {
    try {
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (exe.includes("/") || exe.includes("\\")) return isExec(exe);
  const dirs = String(env.PATH || "").split(pathDelimiter).filter(Boolean);
  return dirs.some((dir) => isExec(join(dir, exe)));
}

// Can a single adapter run now? Launch binary must resolve on PATH AND every
// `requiresEnv` var must be set and non-empty (binary checked first, so the
// reason distinguishes the two). Returns { available, reason }.
export function adapterAvailability(adapter, { env = process.env, onPath = executableOnPath } = {}) {
  const exe = adapter.launch[0];
  if (!onPath(exe, env))
    return { available: false, reason: `its launch binary "${exe}" was not found on PATH` };
  for (const name of adapter.requiresEnv || []) {
    const value = env[name];
    if (value === undefined || value === "")
      return { available: false, reason: `its required environment variable ${name} is unset or empty` };
  }
  return { available: true, reason: null };
}

// Resolve which adapter handles an issue given its labels, honoring availability
// and the route's policy. First label (in order) with a routing entry picks its
// route, else the default. `failover` (default): first available wins.
// `round-robin`: scan starts at `deps.cursors[source]` and wraps, spreading
// dispatches; `nextCursor` is where the next dispatch resumes. Returns
// { name, adapter, source, route, tried, policy, cursorKey, nextCursor }; when
// none is available name/adapter are null and `tried` lists each with why.
export function resolveAdapter(config, labels = [], deps = {}) {
  const { env = process.env, onPath = executableOnPath, cursors = {} } = deps;
  // A route may be a list, a bare name, or an un-normalized `{ adapters, policy }`
  // object; coerce here so it resolves identically to a normalized one.
  const isRouteObject = (r) => r && typeof r === "object" && !Array.isArray(r) && Array.isArray(r.adapters);
  const asList = (route) =>
    Array.isArray(route) ? route : isRouteObject(route) ? route.adapters : [route];

  let source = "routing.default";
  let raw = config.routing.default;
  for (const label of labels) {
    if (config.routing.labels[label]) {
      raw = config.routing.labels[label];
      source = `routing.labels["${label}"]`;
      break;
    }
  }
  const route = asList(raw);
  const policy =
    (config.routing.policies && config.routing.policies[source]) ||
    (isRouteObject(raw) ? raw.policy : undefined) ||
    DEFAULT_POLICY;

  const tried = [];
  const start = ((Number(cursors[source]) || 0) % route.length + route.length) % route.length;
  const order =
    policy === "round-robin"
      ? Array.from({ length: route.length }, (_, i) => (start + i) % route.length)
      : route.map((_, i) => i);
  for (const idx of order) {
    const name = route[idx];
    const adapter = config.adapters[name];
    const { available, reason } = adapterAvailability(adapter, { env, onPath });
    if (available)
      return {
        name,
        adapter,
        source,
        route: route.slice(),
        tried,
        policy,
        cursorKey: source,
        nextCursor: (idx + 1) % route.length,
      };
    tried.push({ name, reason });
  }
  return { name: null, adapter: null, source, route: route.slice(), tried, policy, cursorKey: source, nextCursor: start };
}

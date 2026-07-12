#!/usr/bin/env node
// herd.mjs — the configuration contract for ratchet-herd, the headless fleet
// supervisor. This first slice ships ONLY the config: a loader, a validator,
// and an `init` subcommand. Dispatch, monitoring, and PR verification land in
// later herd issues and build on the normalized config this module returns.
//
// The framework stays pure: which agent CLIs exist, their argv, prompt
// templates, and environment all live in `.ratchet/herd.json` — never in this
// code. This module reads and shapes that file; it never names a specific
// model, terminal multiplexer, or proxy. A purity test enforces that.
// `defaultConfig()` below is the canonical example of the file's shape.
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/herd.mjs init
//                                             node scripts/herd.mjs run

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, accessSync, constants as fsConstants } from "node:fs";
import { dirname, join, isAbsolute, resolve, delimiter as pathDelimiter } from "node:path";
import { fileURLToPath } from "node:url";

// The herd supervisor's implementation modules (herd-survey, -dispatch, -monitor,
// -verify, -review, -retention) ship in the `herd` profile. This file is the
// single CLI entrypoint and ships in `core`, so a trimmed `--profile core`
// install (or an older core-only install) still has `scripts/herd.mjs` — and
// invoking it there prints a clear install hint instead of a raw
// module-not-found error. See the guard at the CLI entrypoint below. The config
// layer (everything this module exports) has no dependency on those modules, so
// importing `herd.mjs` for its config/exports works without the `herd` profile.

// Repo-root resolution — duplicated in scripts/herd-survey.mjs (the `herd`
// profile) so every herd stage imports it from one place. Defined here too
// because `main()` resolves the repo root without statically importing
// herd-survey (which would fail in a core-only install before the guard below
// could run). Keep the two copies in sync; consolidate into a shared `core`
// module if a third copy appears.
export class RepoRootError extends Error {}

export function resolveRepoRoot(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new RepoRootError(
        `herd: not inside a Ratchet checkout — no .git found at or above ${startDir}`,
      );
    }
    dir = parent;
  }
}

// Config location, relative to the repo root. Entrypoints anchor it there via
// resolveRepoRoot so `init`/`run` touch the same file from any subdirectory.
export const CONFIG_PATH = ".ratchet/herd.json";

// How a route picks among its adapters. `failover` (the default) takes the first
// available adapter, unchanged from adapter fallback routing. `round-robin`
// cycles across the available adapters so successive workers spread load instead
// of piling onto the first. Both are generic policy names — no CLI or model is
// named here, so the purity test stays green.
export const SELECTION_POLICIES = Object.freeze(["failover", "round-robin"]);
export const DEFAULT_POLICY = "failover";

// The usage numbers a herd worker can report on its worker-exit event. An
// adapter declares how to read each of these from its own log via a `usage`
// mapping (see normalizeConfig / extractUsage); the framework never knows any
// CLI's log format — the mapping is config, like {model}.
export const USAGE_FIELDS = Object.freeze(["costUsd", "tokensIn", "tokensOut"]);

// Optional top-level fields and the defaults applied when they are omitted.
export const DEFAULTS = Object.freeze({
  maxWorkers: 3,
  pollSeconds: 60,
  reworkCap: 2,
  logDir: ".ratchet/logs",
  // How long the dispatcher waits for a worker to create its claim ref
  // (agent/issue-<N>) before killing it as dispatch-failed. Long enough for an
  // agent CLI to cold-start and reach the claim step — minutes, not seconds.
  claimTimeoutSeconds: 300,
  // How many days a worker log survives after its worker is gone. Logs append
  // per dispatch and resume and stream-json adapters multiply their size, so an
  // unpruned logDir grows without bound; the poll deletes logs older than this
  // whose issue has no live worker. A log of a still-live worker is kept
  // regardless of age.
  logRetentionDays: 14,
});

// The permission/approval-bypass flag each shipped adapter's CLI needs to run
// headless. A herd worker is non-interactive: nobody can answer the prompt the
// claim step raises (it touches .git, which both CLIs guard as sensitive), so
// without this flag the worker stalls, never creates its claim ref, and is
// killed at claimTimeoutSeconds. Only the two CLIs the framework ships defaults
// for are known here; a custom adapter is the operator's business, never flagged.
export const HEADLESS_PERMISSION_FLAGS = Object.freeze({
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
});

// Thrown for every operator-facing config problem. The CLI prints `.message` as
// a single line and exits non-zero — no stack trace ever reaches the user.
export class HerdConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "HerdConfigError";
  }
}

// The default config `init` writes. "claude" and "codex" are CLI *names*, not
// models — the supervisor never interprets them; editing this file is how an
// operator adds, removes, or re-flags agents without touching the framework.
export function defaultConfig() {
  const promptTemplate =
    "Issue {issue} is your entire assignment: take only issue {issue} to a PR, following AGENTS.md. " +
    "Skip AGENTS.md's pick step — do not survey the ready queue, and never claim, work on, or fall " +
    "through to any other issue. An existing agent/issue-{issue} branch is your own prior claim on " +
    "this same assignment: resume it under AGENTS.md's resume rules, never as a foreign claim to exit " +
    "or fall through from. If issue {issue} already has a pull request opened by someone else, exit " +
    "immediately without touching any branch, worktree, or other issue.";
  return {
    maxWorkers: DEFAULTS.maxWorkers,
    pollSeconds: DEFAULTS.pollSeconds,
    reworkCap: DEFAULTS.reworkCap,
    logDir: DEFAULTS.logDir,
    claimTimeoutSeconds: DEFAULTS.claimTimeoutSeconds,
    logRetentionDays: DEFAULTS.logRetentionDays,
    adapters: {
      claude: { launch: ["claude", "-p", HEADLESS_PERMISSION_FLAGS.claude, "{prompt}"], promptTemplate, env: {} },
      codex: { launch: ["codex", "exec", HEADLESS_PERMISSION_FLAGS.codex, "{prompt}"], promptTemplate, env: {} },
    },
    routing: { default: "claude", labels: {} },
  };
}

// Substitute ONLY {prompt}, {issue}, and {model}. Every other brace token —
// {other}, ${bar} — passes through byte-for-byte. Accepts a string or a command
// array (each element rendered); a key not supplied (or supplied as undefined,
// e.g. a model-free adapter) is left verbatim.
export function substitute(template, vars = {}) {
  const render = (s) =>
    String(s).replace(/\{(prompt|issue|model)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined ? String(vars[key]) : whole,
    );
  return Array.isArray(template) ? template.map(render) : render(template);
}

// Extract an adapter's usage numbers from its log text using its config-driven
// `usage` mapping — each field a regex whose first capture group is the number.
// Pure and total: a field whose pattern is invalid, does not match, or captures
// a non-number resolves to null and is named in `unresolved`, so the caller can
// warn without extraction ever throwing (the worker-exit path must never crash).
// Returns { values: { costUsd, tokensIn, tokensOut }, unresolved: [field, ...] }.
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
        // An invalid regex slipped past config validation — treat as unresolved
        // rather than throw; a bad mapping must not crash the supervisor.
      }
    }
    values[field] = value;
    if (value === null) unresolved.push(field);
  }
  return { values, unresolved };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Validate a parsed config object and return a normalized copy: optional
// top-level fields filled from DEFAULTS, and every adapter's `resume` resolved
// to its `launch` when absent. `file` names the source in every error message,
// so a failure always points the operator at the file and the exact problem.
export function normalizeConfig(raw, file = CONFIG_PATH) {
  const fail = (msg) => {
    throw new HerdConfigError(`${file}: ${msg}`);
  };

  if (!isPlainObject(raw)) fail("top level must be a JSON object.");
  if (!isPlainObject(raw.adapters) || Object.keys(raw.adapters).length === 0)
    fail(`"adapters" must be a non-empty object mapping an adapter name to its command config.`);
  if (!isPlainObject(raw.routing) || raw.routing.default === undefined)
    fail(`"routing.default" is required — name the adapter (or ordered list of adapters) to use when no label matches.`);

  const adapters = {};
  for (const [name, adapter] of Object.entries(raw.adapters)) {
    if (!isPlainObject(adapter) || !Array.isArray(adapter.launch) || adapter.launch.length === 0)
      fail(`adapter "${name}" needs a non-empty "launch" command array.`);
    if ("resume" in adapter && (!Array.isArray(adapter.resume) || adapter.resume.length === 0))
      fail(`adapter "${name}" has a "resume" that is not a non-empty command array.`);
    if (
      "requiresEnv" in adapter &&
      (!Array.isArray(adapter.requiresEnv) ||
        !adapter.requiresEnv.every((v) => typeof v === "string" && v !== ""))
    )
      fail(`adapter "${name}" has a "requiresEnv" that is not an array of non-empty variable names.`);
    if ("model" in adapter && (typeof adapter.model !== "string" || adapter.model === ""))
      fail(`adapter "${name}" has a "model" that is not a non-empty string.`);
    // Optional avatar the dashboard renders beside this adapter's worker rows.
    // The core only stores and passes the string — it never fetches or
    // interprets it. Must be a string when present; an empty string is allowed
    // and means "use the bundled default" (treated as absent below).
    if ("avatar" in adapter && typeof adapter.avatar !== "string")
      fail(`adapter "${name}" has an "avatar" that is not a string.`);
    // An adapter that uses the {model} placeholder anywhere it is substituted
    // (launch, resume, or promptTemplate) must declare the model it stands for.
    const hasModel = typeof adapter.model === "string" && adapter.model !== "";
    const usesModel = [
      ...adapter.launch,
      ...(Array.isArray(adapter.resume) ? adapter.resume : []),
      typeof adapter.promptTemplate === "string" ? adapter.promptTemplate : "",
    ].some((part) => /\{model\}/.test(String(part)));
    if (usesModel && !hasModel)
      fail(`adapter "${name}" uses {model} but declares no "model" field.`);
    // Optional: a config-driven mapping declaring how to extract this adapter's
    // cost and token counts from its own log output. Each field is a regex whose
    // first capture group holds the number, so the core reads values it was
    // handed without knowing any CLI's log format — the same purity bar as
    // {model}. When declared, all three fields are required; a missing or
    // non-string field fails here, naming the adapter and the field on one line.
    let usage;
    if ("usage" in adapter) {
      if (!isPlainObject(adapter.usage))
        fail(`adapter "${name}" has a "usage" that is not an object mapping ${USAGE_FIELDS.join(", ")} to extraction patterns.`);
      for (const field of USAGE_FIELDS) {
        const pattern = adapter.usage[field];
        if (typeof pattern !== "string" || pattern === "")
          fail(`adapter "${name}" usage.${field} must be a non-empty string pattern.`);
      }
      usage = { costUsd: adapter.usage.costUsd, tokensIn: adapter.usage.tokensIn, tokensOut: adapter.usage.tokensOut };
    }
    adapters[name] = {
      launch: adapter.launch.slice(),
      // No distinct resume command → resume the same way it launches.
      resume: Array.isArray(adapter.resume) ? adapter.resume.slice() : adapter.launch.slice(),
      promptTemplate: typeof adapter.promptTemplate === "string" ? adapter.promptTemplate : "",
      env: isPlainObject(adapter.env) ? { ...adapter.env } : {},
      // Environment variables that must be set and non-empty for this adapter to
      // be considered available. Generic config the loader validates — never an
      // adapter-specific name baked into the framework.
      requiresEnv: Array.isArray(adapter.requiresEnv) ? adapter.requiresEnv.slice() : [],
      // Optional: present only when declared, so a model-free adapter is byte-for-byte
      // the shape it was before {model} existed (back-compat).
      ...(hasModel ? { model: adapter.model } : {}),
      // Optional avatar, stored only when non-empty. An empty string is dropped
      // here so it is indistinguishable from an absent field downstream — the
      // dashboard then renders the bundled default, never a broken image.
      ...(typeof adapter.avatar === "string" && adapter.avatar !== "" ? { avatar: adapter.avatar } : {}),
      // Optional: present only when declared, so an adapter with no usage mapping
      // keeps its exact prior shape and its exit event omits the usage fields.
      ...(usage ? { usage } : {}),
    };
  }

  // A route is an adapter name, a non-empty ordered list of adapter names, or an
  // object `{ adapters: [...], policy }` that also declares how the route picks
  // among them. Normalize every route to a list plus a selection policy,
  // validating each name resolves to a defined adapter and the policy is known —
  // naming the offending entry (and the bad name or policy) on failure. Returns
  // { list, policy }; the caller keeps the list under routing.default/labels
  // (unchanged shape) and the policy in routing.policies keyed by the same entry.
  const normalizeRoute = (value, entry) => {
    let adaptersValue = value;
    let policy = DEFAULT_POLICY;
    if (isPlainObject(value)) {
      if (value.adapters === undefined)
        fail(`routing entry ${entry} is an object but has no "adapters" — list the adapter name(s) it routes to.`);
      adaptersValue = value.adapters;
      if (value.policy !== undefined) {
        if (typeof value.policy !== "string" || !SELECTION_POLICIES.includes(value.policy))
          fail(`routing entry ${entry} has an unknown policy "${value.policy}" — use one of: ${SELECTION_POLICIES.join(", ")}.`);
        policy = value.policy;
      }
    }
    if (!Array.isArray(adaptersValue) && typeof adaptersValue !== "string")
      fail(`routing entry ${entry} must be an adapter name, a non-empty array of adapter names, or an object with an "adapters" list.`);
    const list = Array.isArray(adaptersValue) ? adaptersValue : [adaptersValue];
    if (list.length === 0)
      fail(`routing entry ${entry} is an empty list — give at least one adapter name.`);
    for (const name of list) {
      if (typeof name !== "string" || name === "")
        fail(`routing entry ${entry} must list adapter names as non-empty strings.`);
      if (!(name in adapters))
        fail(`routing entry ${entry} names "${name}", which is not a defined adapter.`);
    }
    return { list: list.slice(), policy };
  };

  const policies = {};
  const defaultNorm = normalizeRoute(raw.routing.default, "routing.default");
  const defaultRoute = defaultNorm.list;
  policies["routing.default"] = defaultNorm.policy;
  const rawLabels = isPlainObject(raw.routing.labels) ? raw.routing.labels : {};
  const labels = {};
  for (const [label, value] of Object.entries(rawLabels)) {
    const source = `routing.labels["${label}"]`;
    const norm = normalizeRoute(value, source);
    labels[label] = norm.list;
    policies[source] = norm.policy;
  }

  const int = (value, fallback, field, min) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min)
      fail(`"${field}" must be ${min > 0 ? "a positive" : "a non-negative"} integer.`);
    return value;
  };
  const str = (value, fallback, field) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value === "") fail(`"${field}" must be a non-empty string.`);
    return value;
  };

  return {
    maxWorkers: int(raw.maxWorkers, DEFAULTS.maxWorkers, "maxWorkers", 1),
    pollSeconds: int(raw.pollSeconds, DEFAULTS.pollSeconds, "pollSeconds", 1),
    reworkCap: int(raw.reworkCap, DEFAULTS.reworkCap, "reworkCap", 0),
    claimTimeoutSeconds: int(raw.claimTimeoutSeconds, DEFAULTS.claimTimeoutSeconds, "claimTimeoutSeconds", 1),
    logRetentionDays: int(raw.logRetentionDays, DEFAULTS.logRetentionDays, "logRetentionDays", 1),
    logDir: str(raw.logDir, DEFAULTS.logDir, "logDir"),
    adapters,
    routing: { default: defaultRoute, labels: { ...labels }, policies: { ...policies } },
  };
}

// Warn — never fail — when a shipped adapter's launch omits its headless
// permission flag. Returns one single-line message per offending adapter (a
// config written before the flag became a default, or one hand-edited to drop
// it). Silent for any other adapter name, and for a claude/codex adapter whose
// launch already carries its flag. Loading such a config still succeeds (exit
// zero): a deliberately-interactive launch is the operator's call, not an error.
export function headlessFlagWarnings(config) {
  const warnings = [];
  for (const [name, flag] of Object.entries(HEADLESS_PERMISSION_FLAGS)) {
    const adapter = config.adapters[name];
    if (adapter && !adapter.launch.includes(flag))
      warnings.push(
        `WARNING: adapter "${name}" launch is missing ${flag}; a headless worker will stall on a ` +
          `permission prompt and fail to claim. Add ${flag} to its launch in ${CONFIG_PATH}.`,
      );
  }
  return warnings;
}

// Read, parse, validate, and normalize the config at `path`. Throws
// HerdConfigError with a one-line, file-named message for every failure the
// operator can cause: missing file, unreadable file, malformed JSON, bad shape.
// A shipped adapter missing its headless-permission flag is warned, not failed.
export function loadConfig(path = CONFIG_PATH, { warn = true } = {}) {
  if (!existsSync(path))
    throw new HerdConfigError(`${path} not found. Run \`node scripts/herd.mjs init\` to create it.`);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new HerdConfigError(`${path} could not be read: ${e.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new HerdConfigError(`${path} is not valid JSON: ${e.message}`);
  }
  const config = normalizeConfig(raw, path);
  // The live dashboard re-reads config on every snapshot (herd-ui resolveConfig),
  // so it passes warn:false — the headless-flag warning is emitted once at
  // startup, never spammed per poll.
  if (warn) for (const warning of headlessFlagWarnings(config)) console.warn(warning);
  return config;
}

// Write the default config to `path`, refusing to clobber an existing file.
// Creates the parent directory if needed. Returns the path written.
export function initConfig(path = CONFIG_PATH) {
  if (existsSync(path))
    throw new HerdConfigError(
      `${path} already exists — refusing to overwrite. Delete it first to regenerate defaults.`,
    );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(defaultConfig(), null, 2) + "\n");
  return path;
}

// Default availability probe: does `exe` resolve to an executable file? An exe
// containing a path separator is checked at that path directly; a bare name is
// searched across every PATH entry. Injectable everywhere it is used so tests
// decide availability offline without a real fleet installed.
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

// Decide whether a single adapter can actually run right now, deterministically
// and offline-testably: its launch executable must resolve on PATH AND every
// variable it declares in `requiresEnv` must be set and non-empty. The launch
// binary is checked first so the reason distinguishes a missing binary from an
// unset env var. Returns { available, reason }; reason is null when available.
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
// and the route's selection policy. The first label (in the order supplied) with
// a routing entry selects that entry's route; if none match, the default route
// is used. A route is an ordered list of adapter names (a bare name normalized to
// a one-element list). Under the default `failover` policy the first available
// adapter wins — so a config whose preferred binary is present dispatches exactly
// as before. Under `round-robin` the scan starts at `deps.cursors[source]` and
// takes the first available adapter at or after it (wrapping), spreading
// successive dispatches across the available adapters; `nextCursor` is where the
// next dispatch to this route should resume. Returns
// { name, adapter, source, route, tried, policy, cursorKey, nextCursor }: on
// success name/adapter are the winner; when no adapter in the route is available
// both are null and `tried` lists every adapter with why it was unavailable.
export function resolveAdapter(config, labels = [], deps = {}) {
  const { env = process.env, onPath = executableOnPath, cursors = {} } = deps;
  // A route may be a list, a bare adapter name, or an object `{ adapters, policy }`
  // (an un-normalized config). Coerce here too so it resolves identically to a
  // normalized one.
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
  // Policy comes from the normalized routing.policies map, or from an object
  // route on an un-normalized config, defaulting to failover.
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

// --- CLI --------------------------------------------------------------------
// `main` returns a process exit code so it is unit-testable without spawning a
// child. HerdConfigError is the only expected failure and is reported as a
// single stderr line; anything else is a real bug and rethrown.
export function main(argv, { root } = {}) {
  const cmd = argv[0];
  try {
    // Anchor the config at the repo root, not the cwd, so `init`/`run` touch the
    // same `.ratchet/herd.json` from any subdirectory — and fail loudly (via
    // RepoRootError below) rather than write a stray config when run from
    // outside any checkout. Tests inject `root` to sandbox this.
    const configPath = join(root ?? resolveRepoRoot(), CONFIG_PATH);
    if (cmd === "init") {
      const written = initConfig(configPath);
      console.log(`Wrote default config to ${written} (adapters: claude, codex).`);
      return 0;
    }
    // No subcommand or `run`: validate the config and report. The actual poll
    // loop runs from the CLI entrypoint below (it is async); this synchronous
    // branch is the config-validation contract the missing-config and
    // invalid-config paths are exercised through.
    if (cmd === undefined || cmd === "run") {
      const config = loadConfig(configPath);
      const names = Object.keys(config.adapters);
      console.log(
        `herd config OK: ${names.length} adapter(s) [${names.join(", ")}], ` +
          `maxWorkers=${config.maxWorkers}.`,
      );
      return 0;
    }
    console.error(`Unknown command "${cmd}". Usage: node scripts/herd.mjs [init|run]`);
    return 1;
  } catch (e) {
    if (e instanceof HerdConfigError || e instanceof RepoRootError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

const isMain =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  // Guard: the supervisor implementation lives in the `herd` profile
  // (herd-survey.mjs + herd-{dispatch,monitor,verify,review,retention}.mjs).
  // A trimmed `--profile core` install, or an older core-only install, lacks
  // them — invoking `node scripts/herd.mjs` there must print a clear install
  // hint naming the exact command that adds the files, never a raw
  // module-not-found error. Dynamically import the implementation so a missing
  // `herd` profile is caught here with one message, not surfaced by Node's
  // static-import resolver.
  let ghJson, ratchetPaths, runLoop, pollOnce, dispatchOne, surveyReady, monitorOnce, verifyOnce, reviewOnce, retentionOnce;
  try {
    ({ ghJson, ratchetPaths, runLoop, pollOnce } = await import("./herd-survey.mjs"));
    ({ dispatchOne, surveyReady } = await import("./herd-dispatch.mjs"));
    ({ monitorOnce } = await import("./herd-monitor.mjs"));
    ({ verifyOnce } = await import("./herd-verify.mjs"));
    ({ reviewOnce } = await import("./herd-review.mjs"));
    ({ retentionOnce } = await import("./herd-retention.mjs"));
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      console.error(
        "herd: the fleet supervisor files are not installed in this project (the `herd` profile is absent from this install). Add them with:\n" +
          "    bash scripts/bootstrap.sh --version <tag> --profile herd\n" +
          "  (pick a <tag> from https://github.com/praveenvijayan/Ratchet/releases), then re-run.\n" +
          "  If your .ratchet-install.json already lists `herd` in its profiles, run ./scripts/ratchet-update.sh instead.",
      );
      process.exit(1);
    }
    throw e;
  }
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === undefined || cmd === "run") {
    // Supervisor: validate the config, then poll. Each pass surveys/reconciles
    // (pollOnce) and dispatches at most one worker. `--once` does a single pass;
    // `--dry-run` prints the plan without spawning (and implies a single pass);
    // `--max <n>` overrides maxWorkers. Never merges, approves, closes, or
    // labels anything — it observes, dispatches, and escalates.
    let root, config;
    try {
      root = resolveRepoRoot();
      config = loadConfig(join(root, CONFIG_PATH));
    } catch (e) {
      if (e instanceof HerdConfigError || e instanceof RepoRootError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
    // Anchor every `.ratchet/*` path (and the log dir) at the repo root so the
    // whole poll loop reads and writes the one true state regardless of cwd.
    const paths = ratchetPaths(root);
    const anchor = (c) => ({ ...c, logDir: isAbsolute(c.logDir) ? c.logDir : join(root, c.logDir) });
    // Re-read herd.json every poll, mirroring the dashboard: operator edits
    // (adding/removing adapters, avatars, caps) take effect on the next pass
    // without a restart. An invalid file keeps the last good config — one
    // warning per failed poll, never a crash — the same contract the dashboard
    // shows in its config banner. pollSeconds stays the startup value (runLoop
    // holds it); a changed poll interval still needs a restart.
    let liveConfig = anchor(config);
    const resolveConfig = (log) => {
      try {
        liveConfig = anchor(loadConfig(join(root, CONFIG_PATH), { warn: false }));
      } catch (e) {
        if (!(e instanceof HerdConfigError)) throw e;
        log(`herd: herd.json is invalid (${e.message}); keeping the last good config this poll.`);
      }
      return liveConfig;
    };
    const maxIdx = argv.indexOf("--max");
    const dryRun = argv.includes("--dry-run");
    const step = async (o) => {
      const config = resolveConfig(o.log);
      const maxWorkers = maxIdx >= 0 && Number.isInteger(Number(argv[maxIdx + 1]))
        ? Number(argv[maxIdx + 1])
        : config.maxWorkers;
      await pollOnce({ ...o, config });
      // Monitor exited workers (verify / resume / escalate) before dispatching,
      // so a concluded worker frees a slot this same pass. Skipped on --dry-run,
      // which must never spawn (a resume is a spawn).
      if (!dryRun) {
        await monitorOnce({ ...o, config }).catch((e) => {
          o.log(`herd: monitor failed: ${e.message}; continuing to dispatch.`);
        });
        // Verify PRs the monitor just handed off (may dispatch a rework, so it
        // is a spawn — skipped on --dry-run alongside the monitor).
        await verifyOnce({ ...o, config }).catch((e) => {
          o.log(`herd: verify failed: ${e.message}; continuing to dispatch.`);
        });
        // React to review verdicts on ready-for-review PRs (a CHANGES_REQUESTED
        // review dispatches a rework, so it too is a spawn — skipped on --dry-run).
        await reviewOnce({ ...o, config }).catch((e) => {
          o.log(`herd: review failed: ${e.message}; continuing to dispatch.`);
        });
      }
      // Bound events.jsonl / herd-escalations.md growth (mirrors pruneLogs, which
      // pollOnce runs); it only reads and rewrites local files, so — like log
      // pruning — it runs every poll, dry-run included.
      await retentionOnce({ ...o, config }).catch((e) => {
        o.log(`herd: retention failed: ${e.message}; continuing to dispatch.`);
      });
      const ready = await surveyReady(o.gh).catch((e) => {
        o.log(`herd: dispatch survey failed: ${e.message}; skipping dispatch this poll.`);
        return [];
      });
      await dispatchOne({ ...o, config, ready, dryRun, maxWorkers, claimTimeoutMs: config.claimTimeoutSeconds * 1000 });
    };
    runLoop({ gh: ghJson, log: console.log, ...paths, once: argv.includes("--once") || dryRun, pollSeconds: config.pollSeconds, step }).then(
      () => process.exit(0),
      (e) => {
        console.error(`herd: supervisor stopped on an unexpected error: ${e.message}`);
        process.exit(1);
      },
    );
  } else {
    process.exit(main(argv));
  }
}

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

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Adapter resolution lives in the herd-adapters leaf (issue #393): the profile
// modules import it there, outside the herd.mjs ⇄ profile cycle. herd.mjs core
// still uses DEFAULT_POLICY/USAGE_FIELDS in normalizeConfig and re-exports every
// public name, so existing importers of `./herd.mjs` are unchanged. Allowed
// direction only — herd.mjs → herd-adapters, never the reverse.
export {
  DEFAULT_POLICY,
  USAGE_FIELDS,
  executableOnPath,
  adapterAvailability,
  substitute,
  extractUsage,
  resolveAdapter,
} from "./herd-adapters.mjs";
import { DEFAULT_POLICY, USAGE_FIELDS } from "./herd-adapters.mjs";

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

// --- Single-supervisor lock -------------------------------------------------
// A pidfile under `.ratchet/` so two `run` supervisors never poll the same state
// file at once (issue #358). The lock is advisory and self-healing: a supervisor
// that crashed leaves a stale pidfile, and the next `run` detects the dead pid
// and replaces it rather than blocking forever. `--dry-run` neither takes nor is
// refused by the lock — it spawns nothing and mutates no state, so it can always
// run alongside a live supervisor.
export const PID_PATH = ".ratchet/herd.pid";

// Is `pid` a live process? `process.kill(pid, 0)` signals nothing but performs
// the permission/existence check: it throws ESRCH when no such process exists
// (dead → stale lock) and EPERM when the process exists but is owned by another
// user (alive → still holding the lock). Any other error is unexpected and, to
// stay conservative, is treated as "alive" so we never steal a lock we cannot
// prove is dead.
export function pidIsAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    return true;
  }
}

// Read the pid a pidfile holds, or null when the file is missing, empty, or
// corrupt (a garbage pidfile is treated as absent so it never wedges `run`).
function readLockPid(pidPath) {
  let raw;
  try {
    raw = readFileSync(pidPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Acquire the supervisor lock. Returns one of:
//   { ok: true, release }                       — lock taken (fresh)
//   { ok: true, release, stalePid }             — replaced a dead supervisor's lock
//   { ok: true, dryRun: true, release }         — --dry-run: no lock taken or checked
//   { ok: false, livePid }                      — a live supervisor holds it; refused
// The create uses the exclusive `wx` flag so two near-simultaneous starts race
// through the OS: exactly one create succeeds, the loser sees EEXIST and is
// refused, naming the winner's pid.
export function acquireLock({ pidPath, pid = process.pid, isAlive = pidIsAlive, dryRun = false } = {}) {
  if (dryRun) return { ok: true, dryRun: true, release() {} };
  mkdirSync(dirname(pidPath), { recursive: true });
  const holder = readLockPid(pidPath);
  let stalePid = null;
  if (holder !== null && holder !== pid && isAlive(holder)) {
    return { ok: false, livePid: holder };
  }
  // Any file still here is replaceable: a dead holder's stale lock, our own
  // leftover, or a corrupt/empty pidfile (holder null). Clear it so the create
  // below can take the lock — only a *dead named pid* earns a stale notice.
  if (existsSync(pidPath)) {
    if (holder !== null && holder !== pid) stalePid = holder;
    rmSync(pidPath, { force: true });
  }
  try {
    writeFileSync(pidPath, `${pid}\n`, { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // Lost the create race after our read: whoever won now holds the lock.
    const winner = readLockPid(pidPath);
    if (winner !== null && winner !== pid && isAlive(winner)) return { ok: false, livePid: winner };
    // Winner is already gone (dead or cleared) — refuse conservatively rather
    // than loop; the operator simply retries `run`.
    return { ok: false, livePid: winner ?? holder };
  }
  const release = () => releaseLock(pidPath, pid);
  return stalePid !== null ? { ok: true, release, stalePid } : { ok: true, release };
}

// Release the lock, but only if this pid still holds it — never delete a lock a
// different supervisor acquired after we exited. Best-effort: a vanished file is
// already released.
export function releaseLock(pidPath, pid = process.pid) {
  if (readLockPid(pidPath) !== pid) return;
  rmSync(pidPath, { force: true });
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

// Parse the optional issue-targeting flags for `herd run`. Two equivalent forms
// combine into one deduplicated set: the comma list `--issues 12,34` (repeatable)
// and the repeated single `--issue 12 --issue 34`. Targeting is a selection
// *filter*, never a state bypass — the returned set is later intersected with the
// state:ready survey (see dispatchOne), so naming an ineligible issue can never
// dispatch it. This is pure argv parsing with no supervisor dependency, so it
// lives in the core entrypoint and runs before the herd-profile modules load —
// a malformed target list exits 2 even on a core-only install.
//
// Returns { targets, error }:
//   - no targeting flag present -> { targets: null }  (dispatch the whole queue)
//   - all entries valid         -> { targets: [n, …] } (deduplicated; order is
//                                    irrelevant — pickNext re-orders downstream)
//   - any non-integer entry     -> { error: "<usage message>", targets: null }
// The caller turns a non-null error into exit code 2 and spawns nothing.
export function parseIssueTargets(argv) {
  const raw = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--issues") {
      for (const part of String(argv[i + 1] ?? "").split(",")) raw.push(part.trim());
      i++;
    } else if (argv[i] === "--issue") {
      raw.push(String(argv[i + 1] ?? "").trim());
      i++;
    }
  }
  if (raw.length === 0) return { targets: null, error: null };
  const targets = [];
  for (const tok of raw) {
    if (!/^\d+$/.test(tok)) {
      return {
        targets: null,
        error:
          `herd run: --issue/--issues expects positive integer issue numbers, got "${tok}". ` +
          `Usage: herd run [--issues 12,34 | --issue 12 --issue 34] [--max N] [--dry-run] [--once]`,
      };
    }
    const n = Number(tok);
    if (!targets.includes(n)) targets.push(n);
  }
  return { targets, error: null };
}

const isMain =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
// The CLI entry runs inside an async function invoked *without* a top-level
// await. herd.mjs therefore finishes evaluating synchronously, so the dynamic
// profile `import()`s below — and every static import the profile modules make
// back into this file, whether directly (the four adapter/substitute callers,
// now repointed at herd-adapters.mjs) or transitively (herd-retention → herd-ui
// → herd.mjs's config re-import) — resolve against a fully initialised module
// instead of deadlocking the import cycle. A bare top-level `await import(...)`
// here is exactly what Node reports as an unsettled top-level await and kills
// with exit 13 (issue #390); the regression test guards that this block never
// reintroduces one. A rejection rejects runCli and exits 1 rather than
// crashing the module graph with an unhandled rejection.
if (isMain) {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error(e?.stack ?? `herd: ${e}`);
    process.exit(1);
  });
}

async function runCli(argv) {
  const cmd = argv[0];
  // Validate run-mode issue targeting *before* loading the herd-profile modules:
  // parseIssueTargets is pure core arg parsing, so a malformed --issue/--issues
  // exits 2 with a usage message even on a core-only install and never reaches
  // the dispatch import. A valid (or absent) target set flows into the run block.
  let targets = null;
  if (cmd === undefined || cmd === "run") {
    const parsed = parseIssueTargets(argv);
    if (parsed.error) {
      console.error(parsed.error);
      process.exit(2);
    }
    targets = parsed.targets;
  }
  // Guard: the supervisor implementation lives in the `herd` profile
  // (herd-survey.mjs + herd-{dispatch,monitor,verify,review,retention}.mjs).
  // A trimmed `--profile core` install, or an older core-only install, lacks
  // them — invoking `node scripts/herd.mjs` there must print a clear install
  // hint naming the exact command that adds the files, never a raw
  // module-not-found error. Dynamically import the implementation so a missing
  // `herd` profile is caught here with one message, not surfaced by Node's
  // static-import resolver.
  let ghJson, ghConditional, ratchetPaths, runLoop, pollOnce, scopedRun, dispatchOne, surveyReady, supervisorStep, monitorOnce, verifyOnce, reviewOnce, retentionOnce;
  try {
    ({ ghJson, ghConditional, ratchetPaths, runLoop, pollOnce, scopedRun } = await import("./herd-survey.mjs"));
    ({ dispatchOne, surveyReady, supervisorStep } = await import("./herd-dispatch.mjs"));
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
  if (cmd === undefined || cmd === "run") {
    // Supervisor: validate the config, then poll. Each pass surveys/reconciles
    // (pollOnce) and dispatches at most one worker. `--once` does a single pass;
    // `--dry-run` prints the plan without spawning (and implies a single pass);
    // `--max <n>` overrides maxWorkers; `--issues 12,34` / repeated `--issue 12`
    // restrict dispatch to a named set (parsed above, intersected with the ready
    // survey — a filter, never a bypass). Never merges, approves, closes, or
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
    // Take the single-supervisor lock before polling. A live holder refuses this
    // start (naming its pid, leaving the running supervisor and its state file
    // untouched); a dead holder's stale lock is replaced with a notice. --dry-run
    // passes through untouched. The lock is released on every clean exit path
    // below and on SIGINT/SIGTERM, so the next `run` starts without a stale notice.
    const pidPath = join(root, PID_PATH);
    let lock = { release() {} };
    if (!dryRun) {
      lock = acquireLock({ pidPath });
      if (!lock.ok) {
        console.error(
          `herd: another supervisor is already running (pid ${lock.livePid}); refusing to start a second. ` +
            `Stop it first, or wait for it to exit.`,
        );
        process.exit(1);
      }
      if (lock.stalePid != null) {
        console.log(`herd: replaced a stale lock left by dead supervisor pid ${lock.stalePid}.`);
      }
      const releaseAndExit = (signal) => {
        lock.release();
        // 128 + signal number is the conventional exit code for a signal-terminated
        // process; the exact number is not load-bearing, a clean release is.
        process.exit(signal === "SIGINT" ? 130 : 143);
      };
      process.once("SIGINT", () => releaseAndExit("SIGINT"));
      process.once("SIGTERM", () => releaseAndExit("SIGTERM"));
    }
    // A local worker exit registers here (via runLoop/scopedRun's onExitSignal)
    // so the pass composed below reacts immediately — reconciling the exit and
    // dispatching the freed slot without waiting for the next tick (plan 0173).
    // The registered handler becomes `notifyExit`, threaded into each dispatchOne
    // so a worker's process exit fires it.
    let notifyExit = null;
    const onExitSignal = (fn) => {
      notifyExit = fn;
    };
    // Per-endpoint ETag cache, in-memory for this supervisor process. It lives
    // across ticks (the first tick per endpoint is unconditional) so a poll whose
    // upstream is unchanged returns 304s and short-circuits.
    const surveyEtags = {};
    // One kind-aware pass (plan 0173): on the periodic tick supervisorStep runs
    // pollOnce (heartbeat + ETag-conditional survey/reconcile) and retention, and
    // gates the upstream-driven verify/review on whether that survey saw a change;
    // then — every pass — it reconciles exited workers (monitor) and drains the
    // dispatch queue back-to-back. An event pass (a local worker exit) stays lean:
    // monitor + dispatch only, no heartbeat and no upstream verify/review. A
    // scoped run hands `step` the eligible subset via o.targets; the open loop
    // passes none, falling back to the parsed `targets` (null → whole queue).
    // --dry-run never spawns (monitor/verify/review/drain skipped inside step).
    const step = async (o) => {
      const config = resolveConfig(o.log);
      const maxWorkers = maxIdx >= 0 && Number.isInteger(Number(argv[maxIdx + 1]))
        ? Number(argv[maxIdx + 1])
        : config.maxWorkers;
      await supervisorStep({
        ...o,
        config,
        dryRun,
        maxWorkers,
        targets: o.targets ?? targets,
        claimTimeoutMs: config.claimTimeoutSeconds * 1000,
        notifyExit,
        ghc: ghConditional,
        etags: surveyEtags,
        pollOnce,
        surveyReady,
        dispatchOne,
        monitorOnce: dryRun ? null : monitorOnce,
        verifyOnce: dryRun ? null : verifyOnce,
        reviewOnce: dryRun ? null : reviewOnce,
        retentionOnce,
      });
    };
    const onLoopError = (e) => {
      lock.release();
      console.error(`herd: supervisor stopped on an unexpected error: ${e.message}`);
      process.exit(1);
    };
    const once = argv.includes("--once") || dryRun;
    if (targets != null) {
      // Scoped run: gate on target eligibility up front (escalating and skipping
      // any closed/blocked/not-ready/already-tracked issue), then poll only until
      // every eligible target has finished. Its exit code carries the outcome —
      // 0 when the targets ran, SCOPED_NO_ELIGIBLE_EXIT when none were runnable.
      scopedRun({ gh: ghJson, log: console.log, ...paths, targets, once, dryRun, pollSeconds: config.pollSeconds, step, onExitSignal: once ? null : onExitSignal }).then(
        (r) => {
          lock.release();
          process.exit(r.exitCode);
        },
        onLoopError,
      );
    } else {
      runLoop({ gh: ghJson, log: console.log, ...paths, once, pollSeconds: config.pollSeconds, step, onExitSignal: once ? null : onExitSignal }).then(
        () => {
          lock.release();
          process.exit(0);
        },
        onLoopError,
      );
    }
  } else {
    process.exit(main(argv));
  }
}

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

import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoop, pollOnce, ghJson } from "./herd-survey.mjs";
import { dispatchOne, surveyReady } from "./herd-dispatch.mjs";
import { monitorOnce } from "./herd-monitor.mjs";
import { verifyOnce } from "./herd-verify.mjs";

// Config location, relative to the repo root (the supervisor's cwd).
export const CONFIG_PATH = ".ratchet/herd.json";

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
      claude: { launch: ["claude", "-p", "{prompt}"], promptTemplate, env: {} },
      codex: { launch: ["codex", "exec", "{prompt}"], promptTemplate, env: {} },
    },
    routing: { default: "claude", labels: {} },
  };
}

// Substitute ONLY {prompt} and {issue}. Every other brace token — {other},
// {model}, ${bar} — passes through byte-for-byte. Accepts a string or a command
// array (each element rendered); a key not supplied is left verbatim.
export function substitute(template, vars = {}) {
  const render = (s) =>
    String(s).replace(/\{(prompt|issue)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
    );
  return Array.isArray(template) ? template.map(render) : render(template);
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
  if (!isPlainObject(raw.routing) || typeof raw.routing.default !== "string" || raw.routing.default === "")
    fail(`"routing.default" is required — name the adapter to use when no label matches.`);

  const adapters = {};
  for (const [name, adapter] of Object.entries(raw.adapters)) {
    if (!isPlainObject(adapter) || !Array.isArray(adapter.launch) || adapter.launch.length === 0)
      fail(`adapter "${name}" needs a non-empty "launch" command array.`);
    if ("resume" in adapter && (!Array.isArray(adapter.resume) || adapter.resume.length === 0))
      fail(`adapter "${name}" has a "resume" that is not a non-empty command array.`);
    adapters[name] = {
      launch: adapter.launch.slice(),
      // No distinct resume command → resume the same way it launches.
      resume: Array.isArray(adapter.resume) ? adapter.resume.slice() : adapter.launch.slice(),
      promptTemplate: typeof adapter.promptTemplate === "string" ? adapter.promptTemplate : "",
      env: isPlainObject(adapter.env) ? { ...adapter.env } : {},
    };
  }

  if (!(raw.routing.default in adapters))
    fail(`"routing.default" names "${raw.routing.default}", which is not a defined adapter.`);
  const labels = isPlainObject(raw.routing.labels) ? raw.routing.labels : {};
  for (const [label, name] of Object.entries(labels)) {
    if (!(name in adapters))
      fail(`routing label "${label}" maps to "${name}", which is not a defined adapter.`);
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
    routing: { default: raw.routing.default, labels: { ...labels } },
  };
}

// Read, parse, validate, and normalize the config at `path`. Throws
// HerdConfigError with a one-line, file-named message for every failure the
// operator can cause: missing file, unreadable file, malformed JSON, bad shape.
export function loadConfig(path = CONFIG_PATH) {
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
  return normalizeConfig(raw, path);
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

// Resolve which adapter handles an issue given its labels. The first label (in
// the order supplied) with a routing entry wins; if none match, the routing
// default is used. Returns { name, adapter }.
export function resolveAdapter(config, labels = []) {
  for (const label of labels) {
    const name = config.routing.labels[label];
    if (name) return { name, adapter: config.adapters[name] };
  }
  const name = config.routing.default;
  return { name, adapter: config.adapters[name] };
}

// --- CLI --------------------------------------------------------------------
// `main` returns a process exit code so it is unit-testable without spawning a
// child. HerdConfigError is the only expected failure and is reported as a
// single stderr line; anything else is a real bug and rethrown.
export function main(argv) {
  const cmd = argv[0];
  try {
    if (cmd === "init") {
      const written = initConfig();
      console.log(`Wrote default config to ${written} (adapters: claude, codex).`);
      return 0;
    }
    // No subcommand or `run`: validate the config and report. The actual poll
    // loop runs from the CLI entrypoint below (it is async); this synchronous
    // branch is the config-validation contract the missing-config and
    // invalid-config paths are exercised through.
    if (cmd === undefined || cmd === "run") {
      const config = loadConfig();
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
    if (e instanceof HerdConfigError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

const isMain =
  process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === undefined || cmd === "run") {
    // Supervisor: validate the config, then poll. Each pass surveys/reconciles
    // (pollOnce) and dispatches at most one worker. `--once` does a single pass;
    // `--dry-run` prints the plan without spawning (and implies a single pass);
    // `--max <n>` overrides maxWorkers. Never merges, approves, closes, or
    // labels anything — it observes, dispatches, and escalates.
    let config;
    try {
      config = loadConfig();
    } catch (e) {
      if (e instanceof HerdConfigError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
    const maxIdx = argv.indexOf("--max");
    const maxWorkers = maxIdx >= 0 && Number.isInteger(Number(argv[maxIdx + 1]))
      ? Number(argv[maxIdx + 1])
      : config.maxWorkers;
    const dryRun = argv.includes("--dry-run");
    const step = async (o) => {
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
      }
      const ready = await surveyReady(o.gh).catch((e) => {
        o.log(`herd: dispatch survey failed: ${e.message}; skipping dispatch this poll.`);
        return [];
      });
      await dispatchOne({ ...o, config, ready, dryRun, maxWorkers, claimTimeoutMs: config.claimTimeoutSeconds * 1000 });
    };
    runLoop({ gh: ghJson, log: console.log, once: argv.includes("--once") || dryRun, pollSeconds: config.pollSeconds, step }).then(
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

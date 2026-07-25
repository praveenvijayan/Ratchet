#!/usr/bin/env node
// gates-hermetic.mjs — prove no GATES.md test suite depends on a binary that
// only a developer's machine happens to have.
//
// The incident (PR #495): three herd suites named the real `claude` CLI as an
// adapter launch binary, which `herd-adapters.mjs` probes with X_OK before a
// route resolves — so they passed on every machine with Claude Code installed
// (every machine that could have written them) and failed on every CI runner.
// The gate run's environment differed from the developer's, and nothing
// measured the difference.
//
// This guard measures it. It re-runs ONLY the `*.test.mjs` gate rows, once,
// with a PATH mirroring the real one minus every adapter launch binary the
// shipped `defaultConfig()` names — the toolchain (node, git, gh, coreutils…)
// passes through untouched, so the single variable that changes is whether an
// agent CLI is installed. Its row sits after the test rows, so a suite failing
// here already passed under the normal PATH: it fails ONLY under this run.
// Every failure is named — this chain of incidents was made expensive by
// fail-fast hiding the next one. A suite that legitimately needs a real host
// binary declares it in its own source, where the dependency is:
//     // ratchet:requires-host-binary: claude — reason
//
// Zero dependencies. Requires Node 20+. Run:  node scripts/gates-hermetic.mjs
// Reads GATES.md (or BASE_GATES_FILE/GATES_FILE, exactly like run-gates.mjs).

import { accessSync, constants as fsConstants, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter as pathDelimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { GateParseError, parseGates } from "./gates-table.mjs";
import { defaultConfig } from "./herd.mjs";

// Binaries the gate environment must always keep. Hiding one of these would not
// measure "is an agent CLI installed", it would measure "can Node start at all".
export const TOOLCHAIN = Object.freeze(["node", "git", "gh"]);

// The marker a suite writes in its own source to declare a real host binary it
// cannot run without. Named in the suite, never listed in this guard.
export const REQUIRES_MARKER = "ratchet:requires-host-binary";

// Every adapter launch binary named by a herd config — the set to hide. Derived
// from the config object, never from a list kept here, so adding an adapter to
// `defaultConfig()` in herd.mjs extends the guard with no second edit.
export function hiddenBinaries(config) {
  const adapters = (config && config.adapters) || {};
  const names = Object.values(adapters)
    .map((adapter) => (adapter && Array.isArray(adapter.launch) ? adapter.launch[0] : null))
    .filter((exe) => typeof exe === "string" && exe !== "");
  return [...new Set(names)].sort();
}

// The gate rows that run a test suite, with the suite file each names. Only
// these are re-run: the guard must not re-run the whole gate table under a
// second environment.
export function suiteRows(gatesText = "") {
  return parseGates(String(gatesText))
    .filter((row) => !/^TODO:/i.test(row.command))
    .map((row) => {
      const m = /(?:^|[\s/"'])([\w.@/-]*\.test\.mjs)/.exec(row.command);
      return m ? { ...row, file: m[1] } : null;
    })
    .filter(Boolean);
}

// The host binary a suite declares it needs, or null when it declares none.
export function declaredHostBinary(sourceText) {
  const m = new RegExp(`${REQUIRES_MARKER}:\\s*(\\S+)`).exec(String(sourceText || ""));
  return m ? m[1] : null;
}

// Mirror every executable on `env.PATH` into `mirrorDir` as symlinks, skipping
// the hidden names, and return the one-directory PATH that replaces it. Mirror
// rather than drop whole PATH directories: that would also drop the unrelated
// tools living beside an agent CLI, making this guard a source of false reds.
// First-wins shadowing is preserved; a path-bearing hidden entry is ignored,
// since PATH cannot hide an absolute path.
export function shadowPath(hidden, mirrorDir, env = process.env) {
  const hide = new Set(hidden.filter((exe) => !exe.includes("/") && !exe.includes("\\")));
  const linked = new Set();
  for (const dir of String(env.PATH || "").split(pathDelimiter).filter(Boolean)) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // A PATH entry that is missing or unreadable contributes nothing.
    }
    for (const name of entries) {
      if (hide.has(name) || linked.has(name)) continue;
      const target = join(dir, name);
      try {
        if (!statSync(target).isFile()) continue; // follows symlinks; a broken one throws
        accessSync(target, fsConstants.X_OK);
        symlinkSync(target, join(mirrorDir, name));
      } catch {
        continue; // Not executable, or a name we cannot link — it is simply absent.
      }
      linked.add(name);
    }
  }
  return mirrorDir;
}

// Does `exe` resolve on this PATH? Local to the guard so it can prove the built
// environment really hides what it claims to.
function resolvesOn(exe, pathValue) {
  const isExec = (dir) => {
    try {
      accessSync(join(dir, exe), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  return String(pathValue).split(pathDelimiter).filter(Boolean).some(isExec);
}

// --- CLI guard ----------------------------------------------------------
const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  const gatesFile = process.env.BASE_GATES_FILE || process.env.GATES_FILE || "GATES.md";
  const fail = (msg) => {
    console.error(`::error::${msg}`);
    process.exit(1);
  };

  if (!existsSync(gatesFile)) fail(`Gates file not found: ${gatesFile}. Cannot run the agent-CLI-free gate.`);

  let rows;
  try {
    rows = suiteRows(readFileSync(gatesFile, "utf8"));
  } catch (e) {
    if (!(e instanceof GateParseError)) throw e;
    fail(`Cannot run the agent-CLI-free gate — ${gatesFile} has an unparseable gate row. ${e.message}`);
  }
  if (rows.length === 0) fail(`No test-suite gate rows found in ${gatesFile}. Nothing to re-run without the agent CLIs.`);

  const hidden = hiddenBinaries(defaultConfig());
  const collision = hidden.filter((exe) => TOOLCHAIN.includes(exe));
  if (collision.length > 0)
    fail(
      `Adapter launch binary ${collision.join(", ")} is also part of the toolchain (${TOOLCHAIN.join(", ")}). ` +
        `The guard cannot hide it without breaking every suite — rename the adapter's launch binary.`,
    );

  const mirror = shadowPath(hidden, mkdtempSync(join(tmpdir(), "ratchet-hermetic-")));
  const stillVisible = hidden.filter((exe) => !exe.includes("/") && resolvesOn(exe, mirror));
  if (stillVisible.length > 0)
    fail(`The agent-CLI-free environment still exposes ${stillVisible.join(", ")} — the run would prove nothing.`);
  const missingTools = TOOLCHAIN.filter((exe) => !resolvesOn(exe, mirror));
  if (missingTools.length > 0)
    console.log(`::notice::${missingTools.join(", ")} is not on this machine's PATH either, so the run cannot carry it.`);

  console.log(`Re-running ${rows.length} test suite(s) with ${hidden.join(", ")} hidden from PATH.`);
  const env = { ...process.env, PATH: mirror };
  const failed = [];
  for (const { gate, command, file } of rows) {
    let declared = null;
    try {
      declared = declaredHostBinary(readFileSync(file, "utf8"));
    } catch {
      declared = null; // Unreadable suite file: no declaration, so it runs.
    }
    if (declared && hidden.includes(declared)) {
      console.log(`SKIP  ${gate} — ${file} declares it needs the real "${declared}" binary.`);
      continue;
    }
    if (declared)
      console.log(`::notice::${file} declares it needs "${declared}", which this guard does not hide — running it.`);

    const res = spawnSync(command, { shell: true, env, encoding: "utf8" });
    if (res.status === 0) {
      console.log(`PASS  ${gate}`);
      continue;
    }
    // Enough of the tail to carry a whole assertion message: the failure must be
    // readable from the gate log alone, without re-running anything by hand.
    const output = ((res.stdout || "") + (res.stderr || "")).trim().split("\n").slice(-20).join("\n");
    console.log(`FAIL  ${gate} (${file}, exit ${res.status === null ? "signal " + res.signal : res.status})`);
    if (output) console.log(output);
    failed.push({ gate, file });
  }

  if (failed.length > 0) {
    console.error(
      `::error::${failed.length} gate suite(s) fail without the agent CLIs on PATH: ` +
        `${failed.map((f) => f.file).join(", ")}. A gate suite may not depend on a binary outside the toolchain — ` +
        `stub the dependency, or declare it in the suite with "${REQUIRES_MARKER}: <binary>".`,
    );
    process.exit(1);
  }
  console.log(`All ${rows.length} suite(s) pass with no agent CLI installed.`);
}

#!/usr/bin/env node
// gh-api.mjs — the one GitHub REST client every Ratchet script shares.
//
// The same ~20-line fetch client, `per_page=100` pagination loop, and
// token/repo resolution were copied by hand into a dozen scripts and had begun
// to drift. This module is the single authority, following the existing
// shared-module precedent (criteria.mjs, sweep-lease.mjs, gates-table.mjs).
// Migrations of the individual scripts onto it are tracked as separate issues
// so each PR stays within the size cap.
//
// Everything is injectable so it is tested off the network and without a real
// `gh` on PATH (see gh-api.test.mjs): `ghClient` takes a `fetchImpl`, and
// `resolveAuth` takes the environment, a `.env` reader, and a command runner.
//
// Zero dependencies. Node 20+ (ESM).

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const API = "https://api.github.com";
export const API_VERSION = "2022-11-28";

// Build the request function used across the codebase.
// `gh(method, path, body, { allow404 } = {})` issues one authenticated request
// against the REST API and returns the parsed JSON — or null for a 204 No
// Content. Pass `allow404: true` to treat a 404 as a normal, expected outcome
// (e.g. a repo with no releases yet) and receive null instead of a throw. Any
// other non-2xx response throws an Error whose message carries the method,
// path, status, and response text, and whose `status` (numeric HTTP status) and
// `body` (raw response text) properties let callers discriminate one failure
// mode from another (e.g. a tag-collision 422 vs. an invalid-input 422) without
// pattern-matching a flattened message. `fetchImpl` defaults to the global
// fetch; tests pass a stub so no request ever leaves the process.
export function ghClient(token, { fetchImpl = fetch } = {}) {
  return async function gh(method, path, body, { allow404 = false } = {}) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      if (res.status === 404 && allow404) return null;
      const text = await res.text();
      const err = new Error(`${method} ${path} -> ${res.status} ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  };
}

// Follow `per_page=100` pages of a list endpoint until a short (or empty) batch
// signals the last page, and return the concatenated results in page order.
// `gh` is a client from ghClient (or any (method, path) => array). The first
// `per_page`/`page` pair is appended with the correct separator whether or not
// `path` already carries a query string. Pass `cap` to bound the scan: paging
// stops once `cap` items are collected and the result is truncated to `cap`, so
// a caller scanning "the 200 most recent" never walks the whole history. The
// default (Infinity) follows every page, preserving the uncapped behaviour.
export async function paginate(gh, path, { cap = Infinity } = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100 || out.length >= cap) break;
  }
  return cap === Infinity ? out : out.slice(0, cap);
}

// Parse a KEY=VALUE `.env` file into a plain object, tolerating blank lines,
// `#` comments, surrounding whitespace, and single/double quoted values. Never
// throws for a missing file — returns an empty object so resolveAuth can treat
// "no .env" and "empty .env" identically.
export function readEnvFile(path = ".env") {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// Default command runner: run a local command and return its trimmed stdout, or
// undefined if the command is absent or fails (so a missing `gh` degrades to
// "unresolved", not a crash). Tests inject their own runner instead.
function runCommandDefault(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

// Resolve the GitHub token and repository from the environment, falling back to
// the local `gh` CLI. Order:
//   token — GITHUB_TOKEN, then GITHUB_PAT (each from the environment or `.env`),
//           then `gh auth token`.
//   repo  — GITHUB_REPOSITORY (environment or `.env`), then
//           `gh repo view --json nameWithOwner -q .nameWithOwner`.
// Throws one clear, actionable error naming exactly what is missing — the token
// error and the repo error are distinct messages. `env`, `readEnvFile`, and
// `runCommand` are all injectable so the resolution is tested without touching
// the real environment, filesystem, or `gh`.
export function resolveAuth({ env = process.env, readEnv = readEnvFile, runCommand = runCommandDefault } = {}) {
  const dotenv = readEnv();
  const get = (name) => env[name] || dotenv[name];

  const token =
    get("GITHUB_TOKEN") || get("GITHUB_PAT") || runCommand("gh", ["auth", "token"]);
  if (!token) {
    throw new Error(
      "Missing GitHub token. Set GITHUB_TOKEN or GITHUB_PAT (environment or .env), " +
        "or authenticate the gh CLI with `gh auth login`.",
    );
  }

  const repo =
    get("GITHUB_REPOSITORY") ||
    runCommand("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (!repo) {
    throw new Error(
      "Missing GitHub repository. Set GITHUB_REPOSITORY=owner/repo, " +
        "or run inside a repository where `gh repo view` resolves it.",
    );
  }

  return { token, repo };
}

#!/usr/bin/env node
// herd-ui-project-name.test.mjs — the acceptance criteria of issue #410
// (plan 0171) are the test plan: exactly one test per criterion, driven through
// herd-ui.mjs's public interface (the exported resolveProjectName /
// resolveRepoSlug projections, a real dashboard server's /api/snapshot, and the
// server-rendered PAGE_HTML). The header names the product but not the project
// it watches; this suite pins the project-name resolution, its carriage on every
// snapshot, and the client's hide-when-absent header rule. Offline, zero deps.
// Run: node scripts/herd-ui-project-name.test.mjs

import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { readFileSync } from "node:fs";

import { resolveProjectName, resolveRepoSlug, createDashboardServer, listenOrFail, PAGE_HTML } from "./herd-ui.mjs";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
    }).on("error", reject);
  });
}

async function withServer(opts, fn) {
  const server = createDashboardServer({ pollMs: 25, config: { reworkCap: 2, claimTimeoutSeconds: 300 }, ...opts });
  const port = await listenOrFail(server, 0);
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// The client's project-name renderer — the body of renderProject — isolated so
// criteria 1 and 5 assert on the hide/show logic alone.
const RENDER_PROJECT = /function renderProject\(\) \{([\s\S]*?)\n  \}/.exec(PAGE_HTML);

// --- #410 criterion 1: the header renders the project name under the subhead,
// styled consistently with the existing brand block. ---
{
  // The project line lives in the brand block, directly under the subhead.
  assert.match(
    PAGE_HTML,
    /<p class="subhead">Herd Dashboard<\/p>\s*<p class="project" id="project" hidden><\/p>/,
    "the project line sits under the subhead inside the brand block",
  );
  // It is styled by a brand-scoped rule, like .brand .subhead — not left unstyled.
  assert.match(PAGE_HTML, /\.brand \.project \{[^}]*\}/, "the project line has a .brand-scoped style rule");
  assert.ok(RENDER_PROJECT, "the client has a renderProject() function");
  assert.ok(RENDER_PROJECT[1].includes("snapshot.projectName"), "renderProject reads the project name from the snapshot");
  assert.ok(RENDER_PROJECT[1].includes("el.textContent = name"), "renderProject paints the resolved name into the header element");
  assert.ok(PAGE_HTML.includes("function render() { renderProject();"), "renderProject runs on every snapshot render");
}

// --- #410 criterion 2: when the repository has a GitHub origin remote, the
// displayed name is its `owner/repo` slug. ---
{
  const slug = resolveRepoSlug("git@github.com:acme/widgets.git");
  assert.equal(slug, "acme/widgets", "the origin remote resolves to its owner/repo slug");
  // With a slug present it wins over the directory fallback — the name is the slug.
  assert.equal(resolveProjectName({ repoSlug: slug, root: "/tmp/checkout-dir" }), "acme/widgets", "the origin slug is the project name, not the checkout directory");
  assert.equal(resolveProjectName({ repoSlug: "owner/repo" }), "owner/repo", "an https origin slug is used verbatim");
}

// --- #410 criterion 3: when no origin remote exists, the displayed name falls
// back to the repository root directory's basename. ---
{
  assert.equal(resolveProjectName({ repoSlug: null, root: "/home/dev/my-cool-project" }), "my-cool-project", "with no origin, the repo root basename is the project name");
  assert.equal(resolveProjectName({ repoSlug: null, root: "/home/dev/my-cool-project/" }), "my-cool-project", "a trailing slash on the root is tolerated");
}

// --- #410 criterion 4: every dashboard snapshot carries the project name, so
// the value survives live updates without changing. ---
await withServer({ projectName: "acme/widgets" }, async (base) => {
  const first = (await fetchJson(`${base}/api/snapshot`)).json;
  assert.equal(first.projectName, "acme/widgets", "the snapshot carries the resolved project name");
  // A second poll (a live update would push a fresh snapshot) still carries it —
  // the name is resolved once at startup and threaded into every snapshot.
  const second = (await fetchJson(`${base}/api/snapshot`)).json;
  assert.equal(second.projectName, "acme/widgets", "the project name is stable across snapshots");
});

// --- #410 criterion 5: when the snapshot carries no project name, the header
// element is hidden rather than rendered empty. ---
{
  // The element ships hidden, so it never flashes an empty line before the first
  // snapshot, and renderProject re-hides it when the name is absent/blank.
  assert.match(PAGE_HTML, /<p class="project" id="project" hidden><\/p>/, "the project element starts hidden");
  assert.match(PAGE_HTML, /\.brand \.project\[hidden\] \{[^}]*display:none[^}]*\}/, "a hidden project element is display:none, never an empty line");
  assert.ok(RENDER_PROJECT, "the renderProject body is present");
  assert.ok(RENDER_PROJECT[1].includes("el.hidden = true"), "renderProject hides the element when the name is missing or blank");
  assert.ok(/name\.trim\(\) !== ""/.test(RENDER_PROJECT[1]), "a blank name counts as absent — the element hides rather than showing whitespace");
  // The server confirms a nameless run really produces a null projectName.
  await withServer({}, async (base) => {
    const snap = (await fetchJson(`${base}/api/snapshot`)).json;
    assert.equal(snap.projectName, null, "a server given no project name emits a null projectName, which the client hides");
  });
}

// --- #410 criterion 6: every criterion above has exactly one test named after
// it. ---
{
  const self = readFileSync(new URL("./herd-ui-project-name.test.mjs", import.meta.url), "utf8");
  for (let i = 1; i <= 6; i++) {
    const hits = (self.match(new RegExp(`#410 criterion ${i}:`, "g")) || []).length;
    assert.equal(hits, 1, `#410 criterion ${i} must have exactly one test named after it`);
  }
}

console.log("PASS herd-ui-project-name.test.mjs (6 criteria)");

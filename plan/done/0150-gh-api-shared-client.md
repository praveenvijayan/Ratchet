---
title: Add shared GitHub API client module scripts/gh-api.mjs
priority: medium
labels: [scripts, refactor]
blocked_by: []
---

The same ~20-line fetch client (`ghClient`) is byte-identical in six scripts
and near-duplicated in four more, each with its own copy of token/repo
resolution, `.env` loading, and the `per_page=100` pagination loop. Wording of
the copies has already drifted. Extract one authority, following the existing
shared-module precedent (`criteria.mjs`, `sweep-lease.mjs`, `gates-table.mjs`).
This issue adds the module only; migrations are separate issues
(0151-migrate-gh-api-verdict-scripts, 0152-migrate-gh-api-sweep-scripts,
0153-migrate-gh-api-sync-scripts, 0155-migrate-gh-api-metrics-scripts) so each
PR stays within the size cap.

## Acceptance criteria
- [ ] `scripts/gh-api.mjs` exports `ghClient(token, { fetchImpl })` returning the request function with the current headers (Bearer auth, `application/vnd.github+json`, API version), 204-to-null handling, and an error carrying `status` and response text
- [ ] It exports `paginate(gh, path)` that follows `per_page=100` pages until a short batch and returns the concatenated results
- [ ] It exports `resolveAuth()` resolving the token in order `GITHUB_TOKEN`, then `GITHUB_PAT` (environment or `.env`), then `gh auth token`, and the repository in order `GITHUB_REPOSITORY`, then `gh repo view`, throwing one clear error naming what is missing
- [ ] `fetchImpl` and the command runner are injectable so tests exercise the module without network or a real `gh`
- [ ] `scripts/gh-api.mjs` is listed in `ratchet-manifest.json` and `scripts/manifest-check.mjs` passes
- [ ] Every criterion above has exactly one test named after it

## Test notes
- property: paginate returns exactly the union of batches, in order, for 0, 1, and 3-page responses
- resolveAuth failure paths: no token anywhere, token but no repo — each produces a distinct actionable message

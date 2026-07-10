---
title: Let a herd adapter pin a model so different models are dispatchable
priority: medium
labels: [herd]
blocked_by: []
---

Today an adapter's model is baked into its `launch` argv, so there is no way to
say "run this adapter on model X" or to stand up several adapters that differ
only by model (e.g. two OpenRouter models under one CLI). Adapters gain an
optional `model` field and a `{model}` placeholder — substituted like `{prompt}`
and `{issue}` — so a config can name the model explicitly and route work to
specific models.

## Acceptance criteria
- [ ] An adapter may declare a `model` field; `{model}` in that adapter's `launch` argv and `promptTemplate` is replaced with it exactly as `{prompt}`/`{issue}` are, and every other brace token still passes through verbatim
- [ ] An adapter whose `launch` or `promptTemplate` uses `{model}` but declares no `model` exits nonzero with a one-line error naming the adapter and the missing field
- [ ] Two adapters that differ only by `model` both validate and are independently routable and dispatchable
- [ ] `model` is optional: an adapter that neither declares `model` nor uses `{model}` loads and dispatches exactly as before (back-compat)
- [ ] The framework purity test still passes — no specific model name appears in `scripts/herd.mjs` logic; the model lives only in config
- [ ] Every criterion above has exactly one test named after it

## Notes
`{model}` is a config-substitution placeholder in the same family as `{prompt}`
and `{issue}` (0051), so the loader stays pure — it substitutes a string it was
handed and never knows which models exist.

---
title: Make an all-TODO gates run distinguishable in the checks list
priority: low
blocked_by: []
---

An all-TODO gates run emits a warning annotation and a "green but vacuous"
summary line — but the check itself is still a plain green `gates` success,
identical in the PR merge box to a run that verified real gates. The reviewer
learns the difference only by opening the run, which defeats the point of a
glanceable trust anchor.

## Acceptance criteria
- [ ] A gates run in which zero real gates executed is distinguishable in the PR checks list itself, without opening the run
- [ ] A run with at least one real gate keeps the normal success presentation

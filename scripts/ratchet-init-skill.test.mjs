#!/usr/bin/env node
// ratchet-init-skill.test.mjs — regression tests for the human-operated
// ratchet-init setup contract. Zero dependencies.
// Run: node scripts/ratchet-init-skill.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skillPath = fileURLToPath(new URL("../.agents/skills/ratchet-init/SKILL.md", import.meta.url));
const skill = readFileSync(skillPath, "utf8");

// #58 AC1: branch-protection setup must require both CI contexts that pr-gates
// reports, so the size job is binding under protection.
{
  assert.match(
    skill,
    /"required_status_checks": \{ "strict": false, "contexts": \["gates", "size"\] \}/,
    "branch protection command must require both gates and size contexts",
  );
  assert.match(
    skill,
    /Require the `gates` and `size` status checks/,
    "branch protection offer must tell the user both checks are required",
  );
}

// #58 AC2: the admin-enforcement trade-off must be accurate for owner/admin
// PATs, and the safe default must be to apply protection to administrators.
{
  assert.match(skill, /"enforce_admins": true/, "branch protection command must recommend enforce_admins true");
  assert.match(
    skill,
    /recommended default[\s\S]*owner\/admin PAT[\s\S]*bound by protection/,
    "skill must explain why enforce_admins true binds owner/admin PAT agents",
  );
  assert.match(
    skill,
    /If `enforce_admins` is `false`[\s\S]*owner\/admin tokens are exempt/,
    "skill must state that enforce_admins false exempts owner/admin tokens",
  );
}

console.log("PASS ratchet-init-skill.test.mjs (2 criteria, 5 assertions)");

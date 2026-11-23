#!/usr/bin/env node
// The stage-workspace regressions prove the host git floor on the runner's git. They are read against the release whose hook events
// HOOK_EVENTS lists (HOOK_EVENTS_VALIDATED): a runner on another major.minor fails here, with its own message, rather than passing on
// a git the list was not validated for. Moving runners to a newer git means validating the list and bumping that release first.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/shared/host-git.ts", import.meta.url), "utf8");
const pinned = /HOOK_EVENTS_VALIDATED = \[(\d+), (\d+)\]/u.exec(source);
const reported = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
console.log(reported);
const version = /^git version (\d+)\.(\d+)(?:\..*)?$/u.exec(reported);
if (pinned === null || version === null) {
  console.error("::error::cannot read the validated git release or the runner's git version");
  process.exit(1);
}
if (version[1] !== pinned[1] || version[2] !== pinned[2]) {
  console.error(`::error::the runner's git is ${version[1]}.${version[2]}; the hook events were validated against ${pinned[1]}.${pinned[2]}`);
  process.exit(1);
}

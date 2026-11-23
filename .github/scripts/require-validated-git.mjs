#!/usr/bin/env node
// The stage-workspace regressions prove the host git floor on the runner's git, so it must be at least the release whose hook events
// HOOK_EVENTS lists (HOOK_EVENTS_VALIDATED): an older one fails here, with its own message, rather than inside a test. A newer one
// passes and its exact version is logged; the host warns of it at run time too. The git read is the one discovery tries first: the
// first absolute search-path entry that holds it. Discovery takes that one whenever it is at least the product minimum, which is below
// this floor, so a pass here is a pass on the git the regressions start.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

/** The validated release as [major, minor], read from the source that lists the events; null when it cannot be read. */
export function validatedRelease(source) {
  const pinned = /HOOK_EVENTS_VALIDATED = \[(\d+), (\d+)\]/u.exec(source);
  return pinned === null ? null : [Number(pinned[1]), Number(pinned[2])];
}

/** The error a runner's `git --version` answer earns against `floor`, or null when it is at or above it. */
export function gitVersionError(reported, floor) {
  const version = /^git version (\d+)\.(\d+)(?:\..*)?$/u.exec(reported);
  if (floor === null || version === null) return "cannot read the validated git release or the runner's git version";
  const [major, minor] = [Number(version[1]), Number(version[2])];
  if (major < floor[0] || (major === floor[0] && minor < floor[1])) {
    return `the runner's git is ${major}.${minor}; the hook events were validated against ${floor.join(".")}, the lowest release the regressions run on`;
  }
  return null;
}

/** The first git on an absolute search-path entry, as discovery orders them; null when none holds one. */
export function firstPathGit(searchPath = process.env.PATH ?? "", platform = process.platform) {
  const windows = platform === "win32";
  for (const raw of searchPath.split(windows ? ";" : ":")) {
    const entry = raw.trim().replace(/^"(.*)"$/u, "$1");
    if (!(windows ? /^[A-Za-z]:[\\/]/u.test(entry) : posix.isAbsolute(entry))) continue;
    const candidate = windows ? win32.join(entry, "git.exe") : posix.join(entry, "git");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const floor = validatedRelease(readFileSync(new URL("../../src/shared/host-git.ts", import.meta.url), "utf8"));
  const program = firstPathGit();
  const reported = program === null ? "" : execFileSync(program, ["--version"], { encoding: "utf8" }).trim();
  console.log(`${program ?? "no git on the search path"}: ${reported}`);
  const error = gitVersionError(reported, floor);
  if (error !== null) {
    console.error(`::error::${error}`);
    process.exit(1);
  }
}

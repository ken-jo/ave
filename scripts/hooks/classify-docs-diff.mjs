#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { classifyDocumentationChanges } from "./pre-push-markdown-policy.mjs";

const base = process.argv[2];
const head = process.argv[3] ?? "HEAD";
if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(base ?? "") ||
    !/^(?:HEAD|[0-9a-f]{40}(?:[0-9a-f]{24})?)$/i.test(head)) {
  throw new Error("a resolved base and head are required");
}

const result = spawnSync("git", [
  "diff", "--no-renames", "--raw", "-z", `${base}..${head}`, "--",
], { encoding: "buffer" });
if (result.error || result.status !== 0) {
  throw new Error("could not compare documentation changes with the base");
}

const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
const fields = output.split("\0");
if (fields.at(-1) !== "") throw new Error("invalid Git diff output");
fields.pop();
if (fields.length % 2 !== 0) throw new Error("invalid Git diff entries");
const entries = [];
for (let i = 0; i < fields.length; i += 2) {
  const raw = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z][0-9]*)$/i.exec(fields[i]);
  if (!raw) throw new Error("invalid Git diff status or modes");
  entries.push({ oldMode: raw[1], newMode: raw[2], status: raw[3], path: fields[i + 1] });
}
const classification = classifyDocumentationChanges(entries);
process.stdout.write(`docs_only=${classification.docsOnly}\n`);
process.stderr.write(`[docs-impact] ${classification.reason}\n`);

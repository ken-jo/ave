import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// These regressions must compare serialized identities with fixture expectations independent of the producer.
it.each([
  ["src/main/__tests__/document-open.test.ts", "returns a file link without sending a panel request in link mode", "pathToFileURL("],
  ["src/permissions/__tests__/egress-ask.test.ts", "offers the owner's five choices on a kernel-channel host and keys This project on the repository root", "captureApprovalWorkingDirectory("],
  ["src/permissions/__tests__/rules-store-and-decision.test.ts", "lists unvisited projects and retains corrupt sibling errors", "captureApprovalWorkingDirectory("],
])("keeps fixture expectations independent of the producer: %s", (file, name, producer) => {
  const source = readFileSync(resolve(import.meta.dirname, "../..", file), "utf8");
  const start = source.indexOf(`it("${name}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  it", start + 1);
  expect(source.slice(start, end < 0 ? undefined : end)).not.toContain(producer);
});

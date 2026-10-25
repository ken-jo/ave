import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CURL_OPTION_TABLE, WGET_OPTION_TABLE, type ShellOptionTable } from "../shell-option-tables.js";

function readOptions(file: string): Map<string, boolean> {
  const text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
  const options = new Map<string, boolean>();
  for (const line of text.split("\n")) {
    if (file.startsWith("curl")) {
      const match = /^\s*(?:(-[^\s,]),\s+)?(--[\w.-]+)(.*)$/.exec(line);
      if (!match) continue;
      const takesValue = match[3]!.trimStart().startsWith("<");
      for (const option of [match[1], match[2]]) {
        if (option) {
          expect(options.has(option), option).toBe(false);
          options.set(option, takesValue);
        }
      }
    } else {
      const match = /^(-{1,2}[\w-]+)(.*?) \| /.exec(line);
      if (!match) continue;
      expect(options.has(match[1]!), match[1]).toBe(false);
      options.set(match[1]!, match[2]!.trim().length > 0);
    }
  }
  return options;
}

describe("transfer option snapshots", () => {
  it.each([
    ["curl-8.16.0-help-all.txt", CURL_OPTION_TABLE],
    ["wget-1.21.4-options.txt", WGET_OPTION_TABLE],
  ] as const)("matches every short and long option and its arity in %s", (file, table: ShellOptionTable) => {
    const snapshot = readOptions(file);
    expect(snapshot.size).toBeGreaterThan(200);
    const allOptions = Object.values(table).flat();
    expect(new Set(allOptions).size).toBe(allOptions.length);
    expect([...allOptions].sort()).toEqual([...snapshot.keys()].sort());
    for (const [option, takesValue] of snapshot) {
      const roles = Object.entries(table).filter(([, options]) => options.includes(option)).map(([role]) => role);
      expect(roles, option).toHaveLength(1);
      expect(roles[0] === "flag", option).toBe(!takesValue);
    }
    // Help's subject is optional even though the help snapshot uses <subject>.
    expect(table.optionalData).toEqual(file.startsWith("curl") ? ["-h", "--help"] : []);
  });
});

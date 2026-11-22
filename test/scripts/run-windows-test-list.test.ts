import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { windowsTestCommands } from "../../scripts/run-windows-test-list.mjs";
import { COMMAND_LINE_BUDGET_CHARS, commandLineLength } from "../../scripts/hooks/spawn-command.mjs";

describe("Windows test list runner", () => {
  it("runs the complete workflow inventory through bounded commands", () => {
    const job = parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")).jobs["windows-permission-tests"];
    const step = job.steps.find((entry: { name?: string }) => entry.name === "Run Windows native import regressions");
    const runner = "bun run scripts/run-windows-test-list.mjs config/windows-native-tests.txt";
    expect(step.run).toBe(`node .github/scripts/run-in-job.mjs ${runner}`);
    const list = readFileSync(resolve("config/windows-native-tests.txt"), "utf8");
    expect(windowsTestCommands(list).length).toBeGreaterThan(2);
  });
  it("prepares once and preserves the complete inventory across bounded commands", () => {
    const files = Array.from({ length: 1500 }, (_, i) => `src/permissions/__tests__/native-boundary-${i}.test.ts`);
    const commands = windowsTestCommands(files.join("\n"));
    expect(commands[0]).toEqual(["run", "test:prepare"]);
    expect(commands.length).toBeGreaterThan(2);
    expect(commands.slice(1).flatMap(args => args.slice(4))).toEqual(files.map(file => `./${file}`));
    expect(commands.every(args => commandLineLength("bun.exe", args) <= COMMAND_LINE_BUDGET_CHARS)).toBe(true);
  });
  it("accepts a text file marker and removes duplicate entries", () => {
    expect(windowsTestCommands("\uFEFFsrc/data/__tests__/store.test.ts\r\nsrc/data/__tests__/store.test.ts\r\n")).toEqual([
      ["run", "test:prepare"], ["run", "test:vitest", "--", "run", "./src/data/__tests__/store.test.ts"],
    ]);
  });
  it.each(["", "test/../outside.test.ts", "test/e2e/run.spec.ts", "test/screenshots/capture.spec.ts", "test/smoke/live.test.ts"])("rejects an invalid unit inventory: %s", list => {
    expect(() => windowsTestCommands(list)).toThrow();
  });
});

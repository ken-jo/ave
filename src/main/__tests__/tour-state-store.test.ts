import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_TOUR_STATE,
  readTourState,
  writeTourState,
  markScenarioComplete,
  dismissScenario,
} from "../tour-state-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

function tourState(overrides: Partial<Parameters<typeof writeTourState>[0]> = {}): Parameters<typeof writeTourState>[0] {
  return { lastSeenScenario: null, completedScenarios: [], dismissedAt: null, ...overrides };
}

// POSIX mode checks are skipped on Windows, where these mode bits are not enforced.
describe("tour-state-store", () => {
  let prevAveHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    prevAveHome = process.env.AVE_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "ave-tour-state-"));
    process.env.AVE_HOME = tempDir;
  });

  afterEach(async () => {
    if (prevAveHome === undefined) {
      delete process.env.AVE_HOME;
    } else {
      process.env.AVE_HOME = prevAveHome;
    }
    await cleanupTmpDir(tempDir);
  });

  it("returns the default state when no file exists", async () => {
    const state = await readTourState();
    expect(state).toEqual(DEFAULT_TOUR_STATE);
  });

  it("round-trips writeTourState → readTourState", async () => {
    await writeTourState(tourState({ lastSeenScenario: "first-boot-essentials", completedScenarios: ["first-boot-essentials"] }));
    const state = await readTourState();
    expect(state.lastSeenScenario).toBe("first-boot-essentials");
    expect(state.completedScenarios).toEqual(["first-boot-essentials"]);
    expect(state.dismissedAt).toBeNull();
  });

  it("starts empty after quarantining corrupt JSON", async () => {
    await writeTourState(DEFAULT_TOUR_STATE);
    const path = join(tempDir, "onboarding", "tour-state.json");
    writeFileSync(path, "{ not valid json", "utf-8");
    const state = await readTourState();
    expect(state).toEqual(DEFAULT_TOUR_STATE);
  });

  it("creates the namespace directory under ~/.ave/onboarding/", async () => {
    await writeTourState(tourState());
    const dir = join(tempDir, "onboarding");
    const file = join(dir, "tour-state.json");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(file).isFile()).toBe(true);
    // The file body is the persisted JSON — smoke check that writes land in the namespace directory and nothing else.
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    expect(parsed).toEqual(DEFAULT_TOUR_STATE);
  });

  it("enforces 0o700 directory + 0o600 file modes (POSIX only)", async () => {
    if (process.platform === "win32") return;
    await writeTourState(tourState({ lastSeenScenario: "x" }));
    const dir = join(tempDir, "onboarding");
    const file = join(dir, "tour-state.json");
    const dirMode = statSync(dir).mode & 0o777;
    const fileMode = statSync(file).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("markScenarioComplete is idempotent", async () => {
    await markScenarioComplete("a");
    await markScenarioComplete("a");
    const state = await readTourState();
    expect(state.completedScenarios).toEqual(["a"]);
    expect(state.lastSeenScenario).toBe("a");
  });

  it("dismissScenario records dismissedAt without completing", async () => {
    const before = new Date().toISOString();
    const next = await dismissScenario("a");
    expect(next.completedScenarios).toEqual([]);
    expect(next.lastSeenScenario).toBe("a");
    expect(typeof next.dismissedAt).toBe("string");
    // dismissedAt must be ≥ the timestamp captured just before the call.
    expect(next.dismissedAt && next.dismissedAt >= before).toBe(true);
  });

  it("de-dupes corrupted manual edits in completedScenarios", async () => {
    const dir = join(tempDir, "onboarding");
    const path = join(dir, "tour-state.json");
    await writeTourState(DEFAULT_TOUR_STATE);
    writeFileSync(
      path,
      JSON.stringify(tourState({ completedScenarios: ["a", "a", "b", "b", "a"] })),
      "utf-8",
    );
    const state = await readTourState();
    expect(state.completedScenarios.sort()).toEqual(["a", "b"]);
  });

  it("rejects markScenarioComplete with an empty scenarioId", async () => {
    await expect(markScenarioComplete("")).rejects.toThrow(
      /invalid-scenario-id/,
    );
  });
  it("imports legacy completion once while preserving other state", async () => {
    const previous = tourState({
      lastSeenScenario: "another-tour",
      completedScenarios: ["another-tour"],
      dismissedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeTourState(previous);
    const imported = await readTourState(true);
    expect(imported).toEqual({
      ...previous,
      completedScenarios: ["another-tour", "first-boot-essentials"],
    });
    expect(await readTourState()).toEqual(imported);
    const path = join(tempDir, "onboarding", "tour-state.json");
    utimesSync(path, new Date(0), new Date(0));
    const before = statSync(path).mtimeMs;
    expect(await readTourState(true)).toEqual(imported);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("does not create completion for a false legacy flag", async () => {
    expect(await readTourState(false)).toEqual(DEFAULT_TOUR_STATE);
    expect(() => statSync(join(tempDir, "onboarding", "tour-state.json"))).toThrow();
  });

  it("rejects failed imports and permits a durable retry", async () => {
    const blocker = join(tempDir, "onboarding");
    writeFileSync(blocker, "blocked");
    await expect(readTourState(true)).rejects.toThrow();
    expect(readFileSync(blocker, "utf8")).toBe("blocked");
    // Replace only this test's obstruction; the failed import must not poison the queue.
    unlinkSync(blocker);
    expect((await readTourState(true)).completedScenarios).toEqual(["first-boot-essentials"]);
    expect((await readTourState()).completedScenarios).toEqual(["first-boot-essentials"]);
  });

  it("serializes import, completions and dismissal without losing updates", async () => {
    await Promise.all([
      readTourState(true),
      markScenarioComplete("a"),
      markScenarioComplete("b"),
      dismissScenario("c"),
      readTourState(true),
    ]);
    expect(await readTourState()).toEqual({
      lastSeenScenario: "c",
      completedScenarios: ["first-boot-essentials", "a", "b"],
      dismissedAt: expect.any(String),
    });
  });

});

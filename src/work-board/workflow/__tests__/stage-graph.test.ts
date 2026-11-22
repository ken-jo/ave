import { describe, expect, it } from "vitest";
import { assertPinnedVersion, parallelGroupOf, readyStages, stepsOf } from "../stage-graph.js";
import { graphOf, stageOf, versionOf, waitingRuns } from "./stage-fixtures.js";

describe("stage graph", () => {
  it("refuses a version whose recomputed hash differs from the pin", () => {
    const version = versionOf(graphOf([stageOf("a")]));
    const pin = { templateId: version.templateId, version: version.version, graphHash: version.graphHash };
    expect(() => assertPinnedVersion(version, pin)).not.toThrow();
    // The stored hash still equals the pin, but the content no longer hashes to it.
    const edited = { ...version, stages: [stageOf("a", { goal: "Do something else" })] };
    expect(() => assertPinnedVersion(edited, pin)).toThrow(expect.objectContaining({ code: "graph-mismatch" }));
    expect(() => assertPinnedVersion(version, { ...pin, graphHash: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "graph-mismatch" }));
    expect(() => assertPinnedVersion(version, { ...pin, version: 2 })).toThrow(expect.objectContaining({ code: "version-missing" }));
  });

  it("orders stages into steps and refuses a cycle or an unknown stage", () => {
    const graph = { ...graphOf([stageOf("a"), stageOf("b"), stageOf("c", { inputs: ["a"] }), stageOf("d")]), edges: [{ from: "c", to: "d" }] };
    expect(stepsOf(graph)).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(parallelGroupOf(graph, "b")).toEqual(["a", "b"]);
    expect(readyStages(graph, waitingRuns(graph), [])).toEqual(["a", "b"]);
    expect(() => stepsOf(graphOf([stageOf("a", { inputs: ["b"] }), stageOf("b", { inputs: ["a"] })]))).toThrow(expect.objectContaining({ code: "graph-invalid" }));
    expect(() => stepsOf(graphOf([stageOf("a", { inputs: ["nope"] })]))).toThrow(expect.objectContaining({ code: "stage-not-in-version" }));
  });
});

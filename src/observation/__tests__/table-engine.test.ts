import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ parse: vi.fn(), release: vi.fn(), acquire: vi.fn() }));
vi.mock("../../tools/preview-document-process.js", () => ({ acquireParseSlot: mocks.acquire }));
import { createTableObservationEngine } from "../table-engine.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquire.mockImplementation(async (_owner, controller: AbortController) => {
    controller.signal.throwIfAborted();
    return { parse: mocks.parse, release: mocks.release };
  });
});

describe("table observation engine", () => {
  it("uses the existing isolated parser and releases its slot", async () => {
    const result = { format: "xlsx", needsRecalculation: true, sheet: { name: "Sheet1" } };
    mocks.parse.mockResolvedValue(result);
    const bytes = Buffer.from("bounded input");
    expect(await createTableObservationEngine().parse(bytes, "xlsx", 2, new AbortController().signal)).toBe(result);
    expect(mocks.parse).toHaveBeenCalledWith(bytes, "xlsx", 2);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("preserves parser failures and cancellation without a fallback engine", async () => {
    mocks.parse.mockRejectedValue(new Error("parse failure"));
    await expect(createTableObservationEngine().parse(Buffer.from("input"), "xlsx", 0, new AbortController().signal)).rejects.toThrow("parse failure");
    expect(mocks.release).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(createTableObservationEngine().parse(Buffer.from("input"), "xlsx", 0, controller.signal)).rejects.toThrow("cancelled");
  });

  it("reads bounded text without allocating a table parser slot", async () => {
    expect(await createTableObservationEngine().parse(Buffer.from("one\r\ntwo\n"), "text", 0, new AbortController().signal))
      .toEqual({ format: "text", content: "one\r\ntwo", lines: ["one", "two"], totalLines: 2, truncated: false });
    expect(mocks.acquire).not.toHaveBeenCalled();
    await expect(createTableObservationEngine().parse(Buffer.from("one"), "text", 1, new AbortController().signal))
      .rejects.toThrow("Invalid observed text selection.");
  });

  it("reuses host parse admission with the engine cancellation signal", async () => {
    const parse = vi.fn(async () => ({ format: "csv" } as never));
    const signal = new AbortController().signal;
    const input = Buffer.from("value");
    await createTableObservationEngine().parse(input, "csv", 0, signal, { sessionId: "session", parse });
    expect(parse).toHaveBeenCalledWith(input, "csv", 0, signal);
    expect(mocks.acquire).not.toHaveBeenCalled();
  });
});

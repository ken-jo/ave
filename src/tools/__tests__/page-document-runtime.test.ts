import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { pdfFixture } from "../../__tests__/support/page-document-fixtures.js";

vi.mock("@napi-rs/canvas", () => {
  throw new Error("Cannot find native binding skia.test.node");
});

const { observePdfStreamFailures, parsePageDocument } = await import("../page-document-reader.js");

function stream(fail = false): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      if (fail) controller.error(new Error("stream failed"));
      else { controller.enqueue("chunk"); controller.close(); }
    },
  });
}

function fakeDocument() {
  return { _transport: { messageHandler: { sendWithStream: (action: string) => stream(action === "fail") } } };
}

async function drain(readable: ReadableStream<unknown>): Promise<void> {
  const reader = readable.getReader();
  for (;;) if ((await reader.read()).done) return;
}

describe("PDF runtime failures", () => {
  it("names a missing native canvas module instead of a generic read failure", async () => {
    await expect(parsePageDocument(pdfFixture(), "pdf", 0)).rejects.toMatchObject({ code: "renderer-unavailable" });
  });

  it("fails closed when the worker stream hook point is missing", () => {
    for (const document of [{}, { _transport: {} }, { _transport: { messageHandler: {} } }]) {
      expect(() => observePdfStreamFailures(document)).toThrow(expect.objectContaining({ code: "renderer-unavailable" }));
    }
  });

  it("refuses a page whose rendering bypassed the hooked streams", async () => {
    const document = fakeDocument();
    const bypassed = document._transport.messageHandler.sendWithStream;
    const streams = observePdfStreamFailures(document);
    await drain(bypassed("GetOperatorList"));
    await drain(bypassed("GetTextContent"));
    expect(() => streams.assertComplete()).toThrow(expect.objectContaining({ code: "renderer-unavailable" }));
  });

  it("requires both rendering and text streams, then reports their failures", async () => {
    const onlyOperators = fakeDocument();
    const partial = observePdfStreamFailures(onlyOperators);
    await drain(onlyOperators._transport.messageHandler.sendWithStream("GetOperatorList"));
    expect(() => partial.assertComplete()).toThrow(expect.objectContaining({ code: "renderer-unavailable" }));

    const complete = fakeDocument();
    const observed = observePdfStreamFailures(complete);
    await drain(complete._transport.messageHandler.sendWithStream("GetOperatorList"));
    await drain(complete._transport.messageHandler.sendWithStream("GetTextContent"));
    expect(() => observed.assertComplete()).not.toThrow();
    await expect(drain(complete._transport.messageHandler.sendWithStream("fail"))).rejects.toThrow("stream failed");
    expect(() => observed.assertComplete()).toThrow(expect.objectContaining({ code: "corrupt-document" }));

    // Text extraction consumes its stream with for-await rather than getReader().
    const iterated = fakeDocument();
    const iteratedStreams = observePdfStreamFailures(iterated);
    await drain(iterated._transport.messageHandler.sendWithStream("GetOperatorList"));
    for await (const chunk of iterated._transport.messageHandler.sendWithStream("GetTextContent")) expect(chunk).toBe("chunk");
    expect(() => iteratedStreams.assertComplete()).not.toThrow();
    await expect((async () => {
      for await (const chunk of iterated._transport.messageHandler.sendWithStream("fail")) expect(chunk).toBeDefined();
    })()).rejects.toThrow("stream failed");
    expect(() => iteratedStreams.assertComplete()).toThrow(expect.objectContaining({ code: "corrupt-document" }));
  });

  it("ships a pdf.js build without eval-based code paths or an eval option", () => {
    const require = createRequire(import.meta.url);
    for (const file of ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.min.mjs"]) {
      const source = readFileSync(require.resolve(file), "utf8");
      expect(source).not.toMatch(/isEvalSupported|\bnew Function\(|\beval\(/);
    }
  });
});

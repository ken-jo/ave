/** Verify image routing independently of decoder format and size checks. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const decoder = vi.hoisted(() => ({ prepareBytes: vi.fn() }));
vi.mock("../../tools/image-preparation.js", () => ({
  prepareImageBytes: decoder.prepareBytes,
}));

import { mcpToolToTool } from "../mcp-tool-adapter.js";
import { prepareMcpContentImage, renderMcpContent } from "../mcp-tool-content.js";
import type { McpToolCallOutput, McpToolSchema } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";

const SCHEMA: McpToolSchema = {
  name: "screenshot",
  description: "screenshot",
  inputSchema: { type: "object", properties: {} },
} as McpToolSchema;

const PNG_BASE64 = Buffer.from("png-bytes").toString("base64");

function prepared(data = "cHJlcGFyZWQ=") {
  return { data, mimeType: "image/png", bytes: 8, width: 4, height: 2 };
}

async function runTool(output: McpToolCallOutput) {
  const tool = mcpToolToTool("browser", "mcp_browser_screenshot", SCHEMA, async () => output);
  const ctx = { abortSignal: new AbortController().signal } as unknown as ToolExecutionContext;
  return tool.execute({}, ctx);
}

beforeEach(() => {
  decoder.prepareBytes.mockReset();
});

describe("renderMcpContent", () => {
  it("keeps text blocks and leaves a placeholder for each image block", () => {
    const rendered = renderMcpContent([
      { type: "text", text: "before" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: PNG_BASE64, mimeType: "image/jpeg" },
    ]);
    expect(rendered.text).toBe("before\n[image 1: image/png, 9 bytes]\n[image 2: image/jpeg, 9 bytes]");
    expect(rendered.images.map((image) => image.mimeType)).toEqual(["image/png", "image/jpeg"]);
  });

  it("does not treat a malformed image block as an image", () => {
    const blocks = [
      { type: "image", data: "", mimeType: "image/png" },
      { type: "image", data: PNG_BASE64, mimeType: "text/html" },
      { type: "image", data: 7, mimeType: "image/png" },
    ];
    const rendered = renderMcpContent(blocks);
    expect(rendered.images).toEqual([]);
    expect(rendered.text).toBe([
      "[image/png, 0 bytes omitted]",
      "[text/html, 9 bytes omitted]",
      JSON.stringify(blocks[2]),
    ].join("\n"));
  });

  it("replaces audio and embedded resource blobs with a size note and keeps the text parts", () => {
    const audioBase64 = Buffer.alloc(123 * 1024).toString("base64");
    const blobBase64 = Buffer.alloc(2048).toString("base64");
    const textResource = { type: "resource", resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "notes body" } };
    const link = { type: "resource_link", uri: "file:///big.bin", name: "big" };
    const rendered = renderMcpContent([
      { type: "text", text: "transcript follows" },
      { type: "audio", data: audioBase64, mimeType: "audio/ogg" },
      { type: "resource", resource: { uri: "file:///clip.wav", mimeType: "audio/wav", blob: blobBase64 } },
      textResource,
      link,
    ]);
    expect(rendered.images).toEqual([]);
    expect(rendered.text).toBe([
      "transcript follows",
      "[audio/ogg, 123 KB omitted]",
      "[resource file:///clip.wav: audio/wav, 2 KB omitted]",
      JSON.stringify(textResource),
      JSON.stringify(link),
    ].join("\n"));
    expect(rendered.text).not.toContain(audioBase64.slice(0, 64));
    expect(rendered.text).not.toContain(blobBase64.slice(0, 64));
  });
});

describe("MCP tool adapter image routing", () => {
  it("attaches the first image through the shared decoder", async () => {
    decoder.prepareBytes.mockResolvedValueOnce(prepared());
    const result = await runTool({
      text: "captured\n[image 1: image/png, 9 bytes]",
      images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    });
    expect(result.isError).toBe(false);
    expect(result.image).toEqual(prepared());
    expect(result.output).toBe("captured\n[image 1: image/png, 9 bytes]");
    const [bytes, options, signal] = decoder.prepareBytes.mock.calls[0]!;
    expect(Buffer.from(bytes as Uint8Array).toString()).toBe("png-bytes");
    expect(options).toEqual({});
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("tells the model when the image was rejected, and attaches nothing", async () => {
    decoder.prepareBytes.mockRejectedValueOnce(new Error("unsupported-image: not a picture"));
    const result = await runTool({
      text: "[image 1: image/png, 9 bytes]",
      images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    });
    expect(result.isError).toBe(false);
    expect(result.image).toBeUndefined();
    expect(result.output).toContain("[image 1 was not attached: unsupported-image: not a picture]");
  });

  it("names the images beyond the first that are not attached", async () => {
    decoder.prepareBytes.mockResolvedValueOnce(prepared());
    const images = [1, 2, 3].map(() => ({ data: PNG_BASE64, mimeType: "image/png" }));
    const result = await runTool({ text: "three", images });
    expect(result.image).toEqual(prepared());
    expect(result.output).toContain("[images 2-3 were not attached: one image is shown per tool result]");
    expect(decoder.prepareBytes).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversized image before decoding it", async () => {
    const huge = "A".repeat(40 * 1024 * 1024);
    const outcome = await prepareMcpContentImage([{ data: huge, mimeType: "image/png" }]);
    expect(outcome.image).toBeUndefined();
    expect(outcome.note).toContain("image-input-limit");
    expect(decoder.prepareBytes).not.toHaveBeenCalled();
  });

  it("leaves a text-only result untouched", async () => {
    const result = await runTool({ text: "plain" });
    expect(result).toEqual({ output: "plain", isError: false });
    expect(decoder.prepareBytes).not.toHaveBeenCalled();
  });
});

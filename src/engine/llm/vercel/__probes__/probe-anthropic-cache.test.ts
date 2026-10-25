// Real-API probe requires AVE_RUN_PROBES=1 and credentials; records observations under .omc/probes/.
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SHOULD_RUN =
  process.env.AVE_RUN_PROBES === "1" && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!SHOULD_RUN)("probe: anthropic cache providerMetadata", () => {
  it("captures cacheCreationInputTokens / cacheReadInputTokens shape", async () => {
    const { streamText } = await import("ai");
    const { anthropic } = await import("@ai-sdk/anthropic");

    const result = streamText({
      model: anthropic("claude-sonnet-4-5"),
      messages: [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: "You are a helpful assistant. " + "x".repeat(2048),
              // The probed experimental field is absent from the stable type.
              ...({
                experimental_providerMetadata: {
                  anthropic: { cacheControl: { type: "ephemeral" } },
                },
              } as any),
            },
          ],
        },
        { role: "user", content: "Say hi." },
      ] as any,
    });

    const finish = await result.finishReason;
    const usage = await result.usage;
    const pm = await (result as any).providerMetadata;

    const out = {
      finishReason: finish,
      usage,
      providerMetadata: pm,
      capturedAt: new Date().toISOString(),
    };

    const dir = resolve(process.cwd(), ".omc/probes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "anthropic-cache.json"),
      JSON.stringify(out, null, 2),
    );

    expect(finish).toBeDefined();
  }, 60_000);
});

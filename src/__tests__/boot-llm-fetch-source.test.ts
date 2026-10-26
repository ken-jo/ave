import { describe, expect, it } from "vitest";
import { readBootWiring } from "../__tests__/support/boot-wiring-source.js";
import { readRepoFile } from "./test-helpers.js";

describe("boot LLM fetch wiring regression guards", () => {
  it("uses the safe Electron fetch wrapper instead of raw net.fetch", async () => {
    const bootSource = await readBootWiring();

    // Match relative paths at any boot-module depth.
    expect(bootSource).toMatch(/import \{ createSafeLlmFetch \} from "[^"]*safe-llm-fetch\.js";/);
    expect(bootSource).toContain("const electronNetFetch = net.fetch.bind(net);");
    expect(bootSource).toContain("const llmFetch = createSafeLlmFetch(electronNetFetch);");
    expect(bootSource).not.toContain("net.fetch.bind(net) as typeof fetch");
  });

  it("scopes Electron fetch injection to Azure Foundry providers", async () => {
    const bootSource = await readBootWiring();
    // Guard provider fetch selection at the shared selector.
    const providerSource = readRepoFile("src/engine/turn/provider.ts");
    const fetchSelectorSource = readRepoFile("src/engine/llm/marketplace-provider-fetch.ts");

    expect(fetchSelectorSource).toContain('vendor === "azure-foundry"');
    expect(fetchSelectorSource).toContain("? llmFetch");

    expect(bootSource).toContain("selectProviderRuntimeFetch({");

    expect(providerSource).toContain("selectProviderRuntimeFetch({");
    expect(providerSource).toContain("llmFetch: deps.llmFetch,");
    expect(providerSource).toContain("createLoopProvider,");
  });

  it("keeps routine and interactive loops on the shared guarded fetch path", async () => {
    const bootSource = await readBootWiring();

    expect(bootSource).toMatch(/const routineLoopDeps = \{[\s\S]*?llmFetch,/);
    expect(bootSource).toMatch(/createConversationLoop\(\{[\s\S]*?llmFetch,/);
    expect(bootSource).toMatch(/parentDeps: \{[\s\S]*?llmFetch,/);
  });

  it("keeps builtin web_fetch on the single-hop Electron transport", async () => {
    const bootToolsSource = readRepoFile("src/boot/tools.ts");
    const webFetchSource = readRepoFile("src/tools/web-fetch.ts");

    // The SSRF guard needs each redirect hop returned by the transport.
    expect(bootToolsSource).toContain("createWebFetchTool(singleHopNetworkFetch)");
    expect(webFetchSource).toContain(
      "export function createWebFetchTool(singleHopFetch: typeof fetch)",
    );
    expect(webFetchSource).toContain("fetchImpl: singleHopFetch,");
  });
});

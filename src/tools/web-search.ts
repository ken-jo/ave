import { createDynamicTool, type Tool } from "./base.js";
import type { SettingsService } from "../data/settings-store.js";
import { t } from "../i18n/index.js";

// Treat provider shapes as untrusted: mismatches must report explicit errors, never silently become empty results.

interface NormalizedSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export class WebSearchShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchShapeError";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseSearchResponse(
  data: unknown,
  provider: string,
  listKey: string,
  snippetKey: string,
  urlKey: string,
): NormalizedSearchResult[] {
  if (typeof data !== "object" || data === null) {
    throw new WebSearchShapeError(`${provider} response was not a JSON object`);
  }
  const results = (data as Record<string, unknown>)[listKey];
  if (results === undefined) {
    throw new WebSearchShapeError(`${provider} response missing \`${listKey}\``);
  }
  if (!Array.isArray(results)) {
    throw new WebSearchShapeError(`${provider} \`${listKey}\` was not an array`);
  }
  return results.map((r) => ({
    title: asString(r?.title),
    snippet: asString(r?.[snippetKey]),
    url: asString(r?.[urlKey]),
  }));
}

export function parseTavilyResponse(data: unknown): NormalizedSearchResult[] {
  return parseSearchResponse(data, "Tavily", "results", "content", "url");
}

export function parseSerperResponse(data: unknown): NormalizedSearchResult[] {
  return parseSearchResponse(data, "Serper", "organic", "snippet", "link");
}

// Boot injects provider settings and host-network fetch so requests honor system proxy and certificate configuration.
export function createWebSearchTool(
  settingsService: SettingsService,
  networkFetch: typeof fetch,
): Tool {
  return createDynamicTool({
    name: "web_search",
    description: t("be_tools.webSearchDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    arbitraryEgress: true,
    jsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: t("be_tools.webSearchQueryDescription") },
        count: { type: "integer", description: t("be_tools.webSearchCountDescription") },
      },
      required: ["query"],
    },
    execute: async (rawInput) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      const query = args.query as string;
      // Bound count to 1-10 with default 5 before sending it to a provider or HTML parser.
      const rawCount = args.count;
      const count = typeof rawCount === "number" && Number.isFinite(rawCount)
        ? Math.min(10, Math.max(1, Math.floor(rawCount)))
        : 5;
      const ws = settingsService.get("webSearch");
      const apiKey = settingsService.getSecret(`web.apiKey.${ws.provider}`);
      try {
        if (ws.provider === "tavily" && apiKey) {
          const res = await networkFetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: count }),
          });
          const data: unknown = await res.json();
          const results = parseTavilyResponse(data);
          return {
            output: JSON.stringify({ query, provider: "Tavily", results }),
            isError: false,
          };
        }
        if (ws.provider === "serper" && apiKey) {
          const res = await networkFetch("https://google.serper.dev/search", {
            method: "POST",
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: count }),
          });
          const data: unknown = await res.json();
          const results = parseSerperResponse(data);
          return {
            output: JSON.stringify({ query, provider: "Serper", results }),
            isError: false,
          };
        }
        const ddgRes = await networkFetch("https://html.duckduckgo.com/html/", {
          method: "POST",
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ q: query }).toString(),
        });
        const ddgHtml = await ddgRes.text();
        const results: NormalizedSearchResult[] = [];
        const resultBlocks = ddgHtml.split(/class="result\s/g).slice(1, count + 1);
        for (const block of resultBlocks) {
          const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/);
          const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)/);
          if (urlMatch) {
            let url = urlMatch[1];
            const uddg = url.match(/uddg=([^&]+)/);
            if (uddg) url = decodeURIComponent(uddg[1]);
            results.push({ title: urlMatch[2].trim(), snippet: snippetMatch?.[1]?.trim() || "", url });
          }
        }
        return {
          output: JSON.stringify({ query, provider: "DuckDuckGo", results }),
          isError: false,
        };
      } catch (error) {
        return {
          output: JSON.stringify({
            query,
            error: t("be_tools.webSearchError"),
            details: (error as Error).message,
          }),
          isError: true,
        };
      }
    },
  });
}

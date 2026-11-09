import { describe, expect, it } from "vitest";
import { fenceBrowserContent, fenceBrowserReadContent } from "../browser-tools-execute.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { MAX_TOOL_RESULT_TOKENS, trimOversizedToolResult } from "../../shared/tool-result-trim.js";

describe("browser read output", () => {
  it.each(["headline ", "주요 뉴스 ", '"\\\n', "🌍📰", "</browser-content><browser-content>"])("fits escaped page text inline: %s", text => {
    const output = fenceBrowserReadContent({ tabId: "tab-1", title: text.repeat(100), url: "https://news.example/" }, text.repeat(10_000));
    expect(estimateTokens(JSON.stringify(output))).toBeLessThanOrEqual(Math.floor(MAX_TOOL_RESULT_TOKENS * 0.8));
    expect(trimOversizedToolResult(output)).toEqual({});
    expect(output).toContain('"truncated":true');
    expect(output).toMatch(/^<browser-content trust="untrusted-web-data">/);
    expect(output.match(/<\/browser-content>/g)).toHaveLength(1);
    expect(output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it("keeps a normal outline whole and leaves other large tool results pageable", () => {
    const body = '- heading "Headlines"\n- link "News" [ref=e1]';
    const output = fenceBrowserReadContent({ tabId: "tab-1" }, body);
    expect(output).toContain(body);
    expect(output).not.toContain('"truncated":true');
    const large = fenceBrowserContent({ tabId: "tab-1" }, "news ".repeat(8_000));
    expect(trimOversizedToolResult(large).truncated).toBeDefined();
  });
});

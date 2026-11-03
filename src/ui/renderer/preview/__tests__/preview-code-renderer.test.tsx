// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewContent, resolvePreviewRenderer } from "../preview-renderers.js";
import { highlightedLines } from "../../hooks/use-highlighted-code.js";

afterEach(cleanup);

describe("code preview renderer", () => {
  it("is chosen for extensions the bundled highlighter has a grammar for, after markdown and mermaid", () => {
    expect(resolvePreviewRenderer({ text: "", path: "/a/main.py" }).kind).toBe("code");
    expect(resolvePreviewRenderer({ text: "", path: "/a/retry-policy.ts" }).kind).toBe("code");
    expect(resolvePreviewRenderer({ text: "", filename: "deploy.yaml" }).kind).toBe("code");
    expect(resolvePreviewRenderer({ text: "", path: "/a/README.md" }).kind).toBe("markdown");
    expect(resolvePreviewRenderer({ text: "", path: "/a/flow.mmd" }).kind).toBe("mermaid");
    expect(resolvePreviewRenderer({ text: "", path: "/a/notes.txt" }).kind).toBe("text");
    expect(resolvePreviewRenderer({ text: "", path: "/a/payments.log" }).kind).toBe("text");
  });

  it("numbers every line, including a trailing empty one", () => {
    render(<PreviewContent descriptor={{ text: "const a = 1;\n\nexport { a };\n", path: "/p/a.ts" }} />);
    const lines = screen.getAllByTestId("preview-code-line");
    expect(lines.map((line) => line.getAttribute("data-line"))).toEqual(["1", "2", "3", "4"]);
    expect(lines[0]!.textContent).toContain("const a = 1;");
    expect(screen.queryByTestId("preview-code-truncated")).toBeNull();
  });

  it("colours the code once the grammar chunk loads, without network", async () => {
    const { container } = render(<PreviewContent descriptor={{ text: "export const MAX = 3;", path: "/p/a.ts" }} />);
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull());
    expect(screen.getAllByTestId("preview-code-line")).toHaveLength(1);
  });

  it("says only the first lines are shown when the read was truncated", () => {
    const text = Array.from({ length: 5_000 }, (_, index) => `line ${index + 1}`).join("\n");
    render(<PreviewContent descriptor={{ text, path: "/p/big.ts", truncated: true }} />);
    expect(screen.getByTestId("preview-code-truncated").textContent).toContain("5,000");
    expect(screen.getAllByTestId("preview-code-line")).toHaveLength(5_000);
  });
});

describe("highlightedLines", () => {
  it("splits a span that crosses a line break into one piece per line, keeping its class", () => {
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "span", properties: { className: ["hljs-comment"] }, children: [{ type: "text", value: "/* a\nb */" }] },
        { type: "text", value: "\nx" },
      ],
    };
    const lines = highlightedLines(tree as never);
    expect(lines).toEqual([
      [{ text: "/* a", className: "hljs-comment" }],
      [{ text: "b */", className: "hljs-comment" }],
      [{ text: "x", className: undefined }],
    ]);
  });
});

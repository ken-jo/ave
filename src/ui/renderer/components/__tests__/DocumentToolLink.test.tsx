import { render, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentToolLink } from "../DocumentToolLink.js";
import { registerDocumentPanelHost } from "../../preview/agent-document-bridge.js";

const result = JSON.stringify({ ok: true, path: "/workspace/a b.xlsx", mode: "link", opened: false, fileLink: "file:///workspace/a%20b.xlsx" });
afterEach(cleanup);
describe("document result link", () => {
  it("is an actual file link that leaves the panel alone until clicked", async () => {
    const openDocument = vi.fn(async () => true);
    const unregister = registerDocumentPanelHost(undefined, { sessionId: () => "one", isVisible: () => true, openDocument });
    try {
      const ui = render(<DocumentToolLink name="open_document" result={result} sessionId="one" failed={false} />);
      const link = ui.getByRole("link");
      expect(link.getAttribute("href")).toBe("file:///workspace/a%20b.xlsx");
      expect(openDocument).not.toHaveBeenCalled();
      fireEvent.click(link);
      expect(openDocument).toHaveBeenCalledWith("/workspace/a b.xlsx", expect.any(Number));
    } finally { unregister(); }
  });
  it.each([
    { failed: true, name: "open_document", result },
    { failed: false, name: "read_document", result },
    { failed: false, name: "open_document", result: '{"mode":"direct","opened":true}' },
    { failed: false, name: "open_document", result: '{"mode":"link","opened":false,"path":"x","fileLink":"https://evil.example/"}' },
  ])("does not render a successful file link for $name with failed=$failed", (props) => {
    const ui = render(<DocumentToolLink {...props} sessionId="one" />);
    expect(ui.queryByRole("link")).toBeNull();
  });
});

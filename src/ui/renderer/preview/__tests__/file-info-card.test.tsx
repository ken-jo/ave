// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FileInfoCard } from "../FileInfoCard.js";

afterEach(cleanup);

describe("passive file info card", () => {
  it("omits absent file facts and retains an explicitly supplied zero size", () => {
    const view = render(<FileInfoCard name="archive.bin" reason="binary-file" location="/workspace/archive.bin" />);
    const card = screen.getByTestId("file-info");
    expect(card.querySelectorAll("dt")).toHaveLength(1);
    expect(card.querySelector("dd")?.textContent).toBe("/workspace/archive.bin");
    expect(within(card).queryByRole("button")).toBeNull();
    view.rerender(<FileInfoCard name="empty.bin" size={0} />);
    expect(card.querySelectorAll("dt")).toHaveLength(1);
    expect(card.querySelector("dd")?.textContent).toContain("0");
    expect(screen.queryByTestId("file-info-reason")).toBeNull();
  });
});

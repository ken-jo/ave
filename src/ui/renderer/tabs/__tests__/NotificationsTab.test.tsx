import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { NotificationsTab } from "../NotificationsTab.js";

describe("notification settings grouping", () => {
  it("renders sound, OS delivery and hidden notices in one destination", async () => {
    const { api } = makeMockAveApi();
    window.aveApi = api as never;
    const { container, getByTestId } = render(<NotificationsTab api={api as never} />);
    await waitFor(() => expect(container.querySelector('[data-settings-section="chat-signals"]')).toBeTruthy());
    expect(container.querySelector('[data-settings-section="notifications-delivery"]')).toBeTruthy();
    expect(container.querySelector('[data-settings-section="notifications-notices"]')).toBeTruthy();
    expect(getByTestId("show-hidden-notices")).toBeTruthy();
  });
});

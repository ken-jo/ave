import "../../../../../test/renderer/setup.js";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { RestartRequiredRow } from "../RestartRequiredRow.js";
import { ko } from "../../../../i18n/messages/ko.js";

describe("restart-required row", () => {
  it("only offers restart for a pending change", () => {
    const { queryByTestId } = render(<RestartRequiredRow pending={false} />);
    expect(queryByTestId("settings-restart-required")).toBeNull();
  });
  it("uses the guarded restart API and displays its refusal", async () => {
    const { api } = makeMockAveApi();
    api.relaunchApp.mockResolvedValueOnce({ ok: false, error: "plugin-install-in-progress" });
    window.aveApi = api as never;
    const { getByRole, findByRole } = render(<RestartRequiredRow pending />);
    fireEvent.click(getByRole("button", { name: ko["permissionsTab.sandboxRestartNow"] }));
    await waitFor(() => expect(api.relaunchApp).toHaveBeenCalledOnce());
    expect((await findByRole("alert")).textContent).toBe(ko["permissionsTab.sandboxRestartPluginBusy"]);
  });
});

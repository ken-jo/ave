import { act, render } from "@testing-library/react";
import { PermissionsTab } from "../../PermissionsTab.js";

export async function renderPermissionsTab() {
  await act(async () => {
    render(<PermissionsTab />);
  });
}

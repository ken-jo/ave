import "../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { WebTab } from "../tabs/WebTab.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";

describe("settings search destinations", () => {
  it("keeps the key destination visible and explains the disabled control for a provider without keys", async () => {
    const { api } = makeMockAveApi();
    window.aveApi = api as never;
    const { container } = render(<WebTab api={api as never} webProvider="duckduckgo" setWebProvider={() => {}}
      hasWebKey={false} setHasWebKey={() => {}} webKeyInput="" setWebKeyInput={() => {}} onSaved={() => {}} onSaveKey={async () => true} saving={false} />);
    await waitFor(() => {
      const section = container.querySelector('[data-settings-section="web-api-key"]');
      expect(section).toBeTruthy();
      expect(section?.querySelector('input')?.disabled).toBe(true);
      expect(section?.textContent).not.toContain("{label}");
    });
  });
});

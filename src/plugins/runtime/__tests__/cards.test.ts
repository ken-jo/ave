import { describe, expect, it } from "vitest";
import { makeTestManifest } from "../../__tests__/test-helpers.js";
import { buildPluginCard } from "../index.js";

describe("buildPluginCard onboarding projection", () => {
  it("copies declarative onboarding metadata unchanged", () => {
    const manifest = makeTestManifest({
      id: "sample-plugin",
      onboarding: {
        firstTask: {
          priority: 12,
          locales: {
            en: {
              headline: "Sample headline",
              body: "Sample body",
              actionLabel: "Prefill",
              composerPrompt: "Help me use this plugin",
            },
          },
        },
      },
    });

    const card = buildPluginCard(
      manifest.id,
      manifest,
      "loaded",
      null,
      { active: true, runtimeLoaded: true },
      { preparationStatus: undefined, installAliases: undefined },
    );

    expect(card.onboarding).toBe(manifest.onboarding);
  });

  it("keeps onboarding absent for manifests that do not declare it", () => {
    const manifest = makeTestManifest({ id: "sample-plugin" });
    const card = buildPluginCard(
      manifest.id,
      manifest,
      "disabled",
      null,
      { active: false, runtimeLoaded: false },
      { preparationStatus: undefined, installAliases: undefined },
    );

    expect(card.onboarding).toBeUndefined();
    expect(card.loadStatus).toBe("disabled");
    expect(card.active).toBe(false);
  });
});

describe("buildPluginCard host protocol projection", () => {
  const card = (hostProtocol: string | undefined) => {
    const manifest = makeTestManifest({ id: "sample-plugin", requires: { hostProtocol } });
    return buildPluginCard(
      manifest.id,
      manifest,
      "loaded",
      null,
      { active: true, runtimeLoaded: true },
      { preparationStatus: undefined, installAliases: undefined },
    );
  };

  it("names a served protocol so the settings UI can mark legacy extensions", () => {
    expect(card("3").hostProtocol).toBe("3");
    expect(card("4").hostProtocol).toBe("4");
  });

  it("omits the field for an undeclared or unserved protocol", () => {
    expect(card(undefined)).not.toHaveProperty("hostProtocol");
    expect(card("2")).not.toHaveProperty("hostProtocol");
  });
});

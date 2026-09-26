import { describe, expect, it } from "vitest";
import { translate } from "../../../../../i18n/translate.js";
import { kindLabel } from "../labels.js";

describe("package kind display vocabulary", () => {
  it("labels code packages as extensions and entry-free bundles as plugins", () => {
    const codePackage = { kind: "plugin" } as const;
    const bundlePackage = { kind: "agent-plugin" } as const;

    expect(kindLabel((key) => translate("en", key), codePackage.kind, "en")).toBe("Extensions");
    expect(kindLabel((key) => translate("ko", key), codePackage.kind, "ko")).toBe("익스텐션");
    expect(kindLabel((key) => translate("en", key), bundlePackage.kind, "en")).toBe("Plugin");
    expect(kindLabel((key) => translate("ko", key), bundlePackage.kind, "ko")).toBe("플러그인");
  });
});

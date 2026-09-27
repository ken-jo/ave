import { describe, expect, it } from "vitest";
import { translate } from "../../../../../i18n/translate.js";
import { kindLabel } from "../labels.js";

describe("package kind display vocabulary", () => {
  it("labels code packages as extensions and entry-free bundles as plugins", () => {
    const codePackage = { kind: "plugin" } as const;
    const bundlePackage = { kind: "agent-plugin" } as const;

    expect(kindLabel((key) => translate("en", key), codePackage.kind)).toBe("Extensions");
    expect(kindLabel((key) => translate("ko", key), codePackage.kind)).toBe("익스텐션");
    expect(kindLabel((key) => translate("en", key), bundlePackage.kind)).toBe("Plugins");
    expect(kindLabel((key) => translate("ko", key), bundlePackage.kind)).toBe("플러그인");
  });
});

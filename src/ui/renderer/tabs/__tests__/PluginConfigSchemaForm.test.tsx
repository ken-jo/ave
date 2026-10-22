// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "../../../../i18n/react.js";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { PluginConfigSchemaForm } from "../PluginConfigSchemaForm.js";
import type { PluginConfigSchemaSummary } from "../../types.js";

describe("PluginConfigSchemaForm field text language", () => {
  // The shape of the reported problem: the property's own text is Korean.
  const schema: PluginConfigSchemaSummary = {
    properties: {
      folder: {
        type: "string",
        title: "인덱싱 폴더",
        description: "스캔할 폴더입니다.",
        locales: { en: { title: "Index folder", description: "The folder to scan." } },
      },
      depth: { type: "integer", title: "깊이" },
    },
  };
  const tree = (locale: string) => (
    <I18nProvider locale={locale} setLocale={() => undefined}>
      <PluginConfigSchemaForm
        pluginId="indexer"
        schema={schema}
        values={{}}
        secretsPresent={{}}
        onSave={() => undefined}
        onSetSecret={() => undefined}
      />
    </I18nProvider>
  );

  it("resolves title and description through locales and follows a language switch", () => {
    const suiteLocale = getLocale();
    try {
      const { rerender } = render(tree("en"));
      expect(screen.getByText("Index folder")).toBeInTheDocument();
      expect(screen.getByText("The folder to scan.")).toBeInTheDocument();
      // No `en` entry: the property's own title stands.
      expect(screen.getByText("깊이")).toBeInTheDocument();

      rerender(tree("ko"));
      expect(screen.getByText("인덱싱 폴더")).toBeInTheDocument();
      expect(screen.getByText("스캔할 폴더입니다.")).toBeInTheDocument();
      expect(screen.queryByText("Index folder")).toBeNull();
    } finally {
      setLocale(suiteLocale);
    }
  });
});

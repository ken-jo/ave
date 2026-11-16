// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../../../../i18n/react.js";
import type { Locale } from "../../../../i18n/locale.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import { PluginConfigSchemaForm } from "../PluginConfigSchemaForm.js";
import { requiredFixture } from "../../../../__tests__/support/required-fixture.js";
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
  const tree = (locale: Locale) => (
    <I18nProvider locale={locale} setLocale={() => undefined}>
      <PluginConfigSchemaForm
        pluginId="indexer"
        schema={schema}
        values={{}}
        secretsPresent={{}}
        onResetField={() => undefined}
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

describe("PluginConfigSchemaForm validation and secret persistence", () => {
  function form(schema: PluginConfigSchemaSummary, values: Record<string, unknown> = {}, secretsPresent: Record<string, boolean> = {}) {
    const onSave = vi.fn(async (_values: Record<string, unknown>) => undefined);
    const onSetSecret = vi.fn(async (_key: string, _value: string) => undefined);
    const { rerender } = render(<PluginConfigSchemaForm pluginId="settings-extension" schema={schema} values={values}
      secretsPresent={secretsPresent} onResetField={() => undefined} onSave={onSave} onSetSecret={onSetSecret} />);
    const updateSecretPresence = (next: Record<string, boolean>) => rerender(<PluginConfigSchemaForm
      pluginId="settings-extension" schema={schema} values={values} secretsPresent={next} onResetField={() => undefined} onSave={onSave} onSetSecret={onSetSecret} />);
    return { onSave, onSetSecret, updateSecretPresence };
  }

  it("blocks invalid bounds and integer fractions from Save and Enter without truncation", async () => {
    const { onSave } = form({ properties: { count: { type: "integer", minimum: 1, maximum: 10 } } }, { count: 2 });
    const input = screen.getByRole("spinbutton");
    const save = screen.getByTestId("pcfg:settings-extension:count:save");
    for (const value of ["-1", "11", "1.5"]) {
      fireEvent.change(input, { target: { value } });
      expect(save).toBeDisabled();
      expect(input).toHaveValue(Number(value));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSave).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith({ count: 4 }));
  });

  it("blocks pattern errors and clearing required values", () => {
    const { onSave } = form({ properties: { name: { type: "string", pattern: "^[a-z]+$", minLength: 2 } }, required: ["name"] }, { name: "valid" });
    const input = screen.getByRole("textbox");
    for (const value of ["", "x", "bad!"]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByTestId("pcfg:settings-extension:name:save")).toBeDisabled();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSave).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toBeInTheDocument();
    }
  });

  it("saves initially missing required fields together only when the draft is valid", async () => {
    const { onSave } = form({ properties: { first: { type: "string" }, second: { type: "string" } }, required: ["first", "second"] });
    const fields = screen.getAllByRole("textbox");
    const save = screen.getByTestId("settings-extension:save-required");
    fireEvent.change(fields[0], { target: { value: "one" } });
    expect(save).toBeDisabled();
    fireEvent.change(fields[1], { target: { value: "two" } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith({ first: "one", second: "two" }));
  });

  it("restores a refused toggle to its stored value, shows the error and keeps it after a refresh", async () => {
    const { onSave, updateSecretPresence } = form({ properties: { sync: { type: "boolean" } } }, { sync: false });
    onSave.mockRejectedValueOnce(new Error("write refused"));
    const toggle = requiredFixture(document.getElementById("pcfg:settings-extension:sync"));
    fireEvent.click(toggle);
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ sync: true });
    await waitFor(() => expect(screen.getByText(t("pluginConfigTab.errorSave"))).toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-checked", "false");
    updateSecretPresence({});
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("restores a refused selection to its stored value", async () => {
    const { onSave } = form({ properties: { effort: { type: "string", enum: ["low", "high"] } } }, { effort: "low" });
    onSave.mockRejectedValueOnce(new Error("write refused"));
    const select = document.getElementById("pcfg:settings-extension:effort") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "high" } });
    await waitFor(() => expect(screen.getByText(t("pluginConfigTab.errorSave"))).toBeInTheDocument());
    expect(select).toHaveValue("low");
  });

  it("keeps a newer choice when an earlier write of the same toggle is refused", async () => {
    const { onSave } = form({ properties: { sync: { type: "boolean" } } }, { sync: false });
    let refuse!: (error: Error) => void;
    onSave.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { refuse = reject; }));
    const toggle = requiredFixture(document.getElementById("pcfg:settings-extension:sync"));
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(onSave).toHaveBeenCalledTimes(3);
    refuse(new Error("write refused"));
    await waitFor(() => expect(screen.getByText(t("pluginConfigTab.errorSave"))).toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("keeps a failed secret draft and reports the failure inline", async () => {
    const { onSetSecret } = form({ properties: { token: { type: "string", format: "secret" } } });
    onSetSecret.mockRejectedValueOnce(new Error("store unavailable"));
    const input = screen.getByTestId("pcfg:settings-extension:token:input");
    fireEvent.change(input, { target: { value: "typed-secret" } });
    fireEvent.click(screen.getByTestId("pcfg:settings-extension:token:save"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(input).toHaveValue("typed-secret");
    expect(screen.getByTestId("pcfg:settings-extension:token:save")).not.toBeDisabled();
  });

  it("deletes a stored secret through the secret channel with an empty value", async () => {
    const { onSave, onSetSecret } = form({ properties: { token: { type: "string", format: "secret" } } }, {}, { token: true });
    fireEvent.click(screen.getByTestId("pcfg:settings-extension:token:delete"));
    await waitFor(() => expect(onSetSecret).toHaveBeenCalledExactlyOnceWith("token", ""));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("keeps required stored secrets replaceable while hiding deletion", async () => {
    const { onSetSecret } = form({ properties: { token: { type: "string", format: "secret" } }, required: ["token"] }, {}, { token: true });
    expect(screen.queryByTestId("pcfg:settings-extension:token:delete")).not.toBeInTheDocument();
    const input = screen.getByTestId("pcfg:settings-extension:token:input");
    fireEvent.change(input, { target: { value: "replacement-secret" } });
    fireEvent.click(screen.getByTestId("pcfg:settings-extension:token:save"));
    await waitFor(() => expect(onSetSecret).toHaveBeenCalledExactlyOnceWith("token", "replacement-secret"));
  });

  it("waits for required secret presence before saving a complete initial cleartext setup", async () => {
    const { onSave, onSetSecret, updateSecretPresence } = form({
      properties: { token: { type: "string", format: "secret" }, name: { type: "string" } }, required: ["name", "token"],
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "valid-name" } });
    const save = screen.getByTestId("settings-extension:save-required");
    expect(save).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("pcfg:settings-extension:token:input"), { target: { value: "required-secret" } });
    fireEvent.click(screen.getByTestId("pcfg:settings-extension:token:save"));
    await waitFor(() => expect(onSetSecret).toHaveBeenCalledExactlyOnceWith("token", "required-secret"));
    expect(save).toBeDisabled();
    updateSecretPresence({ token: true });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith({ name: "valid-name" }));
  });

  it("blocks individual cleartext saves until the required secret is present", async () => {
    const { onSave, updateSecretPresence } = form({
      properties: { token: { type: "string", format: "secret" }, name: { type: "string" } }, required: ["token"],
    }, { name: "old-name" });
    const name = screen.getByRole("textbox");
    fireEvent.change(name, { target: { value: "new-name" } });
    const save = screen.getByTestId("pcfg:settings-extension:name:save");
    expect(save).toBeDisabled();
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    updateSecretPresence({ token: true });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith({ name: "new-name" }));
  });
});

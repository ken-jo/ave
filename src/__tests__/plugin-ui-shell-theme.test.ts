/** Pre-paint must use the shared theme payload fields and host root attributes. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { SafeThemePayload } from "../shared/plugin-theme-cache.js";

const here = dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(resolve(here, "..", "plugin-ui-shell.js"), "utf8");

type FakeRoot = {
  attributes: Map<string, string>;
  properties: Map<string, string>;
  colorScheme: string;
};

async function runShell(theme: unknown): Promise<FakeRoot> {
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  const style = {
    colorScheme: "",
    setProperty(name: string, value: string) {
      properties.set(name, value);
    },
  };
  const documentElement = {
    style,
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
  const mountRoot = { textContent: "", style: {} as Record<string, string> };
  const context = createContext({
    console: { warn() {}, error() {} },
    document: {
      documentElement,
      body: null,
      getElementById: (id: string) => (id === "root" ? mountRoot : null),
    },
    window: {
      avePlugin: {
        getEntryUrl: async () => "ave-plugin://asset/fixture/entry.js",
        getTheme: async () => theme,
      },
    },
  });
  // Entry import fails without a module loader here, after the pre-paint under test.
  await new Script(shellSource).runInContext(context);
  return { attributes, properties, colorScheme: style.colorScheme };
}

describe("plugin UI shell theme pre-paint", () => {
  it("applies bundle, shell, color scheme and tokens from the host payload", async () => {
    const payload: SafeThemePayload = {
      bundleId: "moonstone",
      shell: "light",
      tokens: { "--ave-background": "hsl(220 20% 98%)", "not-a-token": "x" },
    };
    const root = await runShell(payload);
    expect(root.attributes.get("data-theme-bundle")).toBe("moonstone");
    expect(root.attributes.get("data-shell")).toBe("light");
    expect(root.colorScheme).toBe("light");
    expect(root.properties.get("--ave-background")).toBe("hsl(220 20% 98%)");
    expect(root.properties.has("not-a-token")).toBe(false);
  });

  it("prefers an explicit colorScheme over the shell", async () => {
    const root = await runShell({ bundleId: "moonstone", shell: "light", colorScheme: "dark", tokens: {} });
    expect(root.colorScheme).toBe("dark");
  });

  it("writes no attribute before the host's first broadcast", async () => {
    const root = await runShell(null);
    expect(root.attributes.size).toBe(0);
    expect(root.colorScheme).toBe("");
  });

  it("does not read the retired theme, codeTheme and chatTheme fields", () => {
    expect(shellSource).not.toMatch(/\btheme\.(?:theme|codeTheme|chatTheme)\b/);
    expect(shellSource).not.toMatch(/data-(?:code|chat)-theme/);
  });
});

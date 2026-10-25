// A real guest must complete initialization through the production bridge without self-echo.
// Plain frame tests cannot establish the desktop guest transport boundary.
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchElectron } from "./seeded-electron.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
// Bundle beside production main output so relative preload resolution reaches the real preload.
const OUT_DIR = path.join(REPO_ROOT, "dist/src/main");
const MAIN_OUT = path.join(OUT_DIR, "mcp-app-handshake-main.js");

test.beforeAll(async () => {
  const preload = path.join(REPO_ROOT, "dist/src/mcp-app-preload.cjs");
  if (!fs.existsSync(preload)) {
    throw new Error(`Relay preload not built at ${preload}. Run 'bun run build' first.`);
  }

  for (const [entry, outfile] of [
    ["host.ts", path.join(OUT_DIR, "mcp-app-handshake-host.js")],
    ["inner-app.ts", path.join(OUT_DIR, "mcp-app-handshake-inner.js")],
  ] as const) {
    await build({
      entryPoints: [path.join(HERE, "mcp-app-handshake", entry)],
      outfile,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
  }

  await build({
    entryPoints: [path.join(HERE, "mcp-app-handshake/main.ts")],
    outfile: MAIN_OUT,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["electron"],
    banner: {
      js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
    logLevel: "silent",
  });
});

test("real <webview> completes ui/initialize with an UNMODIFIED ext-apps App", async () => {
  const app = await launchElectron({
    args: [MAIN_OUT, "--no-sandbox"],
    timeout: 30_000,
  });

  const lines: string[] = [];
  app.process().stdout?.on("data", (d: Buffer) => {
    const text = d.toString();
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("E2E_")) lines.push(line.trim());
    }
  });
  app.process().stderr?.on("data", (d: Buffer) => process.stdout.write(`[electron:stderr] ${d}`));

  const waitFor = async (marker: string): Promise<void> => {
    await expect
      .poll(() => lines.some((l) => l.includes(marker)), { timeout: 30_000, intervals: [100] })
      .toBe(true);
  };

  try {
    // The relay-ready marker proves session preload injection reached the guest.
    await waitFor("SANDBOX_READY");

    // Distinct parent identity rules out self-echo.
    await waitFor("PARENT_IS_SELF:false");

    // Host initialization proves the unmodified guest accepted the response across the full transport.
    await waitFor("HANDSHAKE_OK");
    await waitFor("INNER_CONNECTED");

    expect(lines.join("\n")).not.toContain("INNER_CONNECT_FAILED");
    expect(lines.join("\n")).not.toContain("BRIDGE_CONNECT_FAILED");
    expect(lines.some((l) => l.includes("PARENT_IS_SELF:true"))).toBe(false);
  } finally {
    await app.close().catch(() => {});
  }
});

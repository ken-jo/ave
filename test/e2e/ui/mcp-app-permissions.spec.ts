// Sandbox and host need distinct origins while the guest keeps scripts and same-origin capability.
// Measure real per-resource permission delivery and fail-closed refusals.
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { launchElectron } from "./seeded-electron.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const OUT_DIR = path.join(REPO_ROOT, "dist/src/main");
const MAIN_OUT = path.join(OUT_DIR, "mcp-app-permissions-main.js");

test.beforeAll(async () => {
  const preload = path.join(REPO_ROOT, "dist/src/mcp-app-preload.cjs");
  if (!fs.existsSync(preload)) {
    throw new Error(`Relay preload not built at ${preload}. Run 'bun run build' first.`);
  }

  for (const [entry, outfile] of [
    ["host.ts", path.join(OUT_DIR, "mcp-app-permissions-host.js")],
    ["probe-app.ts", path.join(OUT_DIR, "mcp-app-permissions-probe.js")],
  ] as const) {
    await build({
      entryPoints: [path.join(HERE, "mcp-app-permissions", entry)],
      outfile,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
  }

  await build({
    entryPoints: [path.join(HERE, "mcp-app-permissions/main.ts")],
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

test.setTimeout(180_000);

test("MCP-App permissions: what the host can actually deliver, measured in a real <webview>", async () => {
  const app = await launchElectron({ args: [MAIN_OUT, "--no-sandbox"], timeout: 30_000 });

  const lines: string[] = [];
  app.process().stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim().startsWith("E2E_")) lines.push(line.trim());
    }
  });

  const outcome = (label: string, feature: string): string => {
    const prefix = `E2E_PROBE ${label} ${feature}:`;
    return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? "<no-result>";
  };
  const frame = (label: string): { allow: string | null; sandbox: string | null; meta: string | null } => {
    const prefix = `E2E_PROBE ${label} FRAME:`;
    const line = lines.find((l) => l.startsWith(prefix));
    if (!line) throw new Error(`no FRAME line for ${label}`);
    return JSON.parse(line.slice(prefix.length));
  };

  // Only NotAllowedError proves denial; missing or unreadable hardware can still mean permission was granted.
  const mediaGranted = (o: string): boolean => o === "ok" || !/NotAllowedError/.test(o);
  const mediaDenied = (o: string): boolean => /NotAllowedError/.test(o);
  // Geolocation code 1 means denied; unavailable positioning does not.
  const geoGranted = (o: string): boolean => o === "ok" || (!/code=1/.test(o) && !/permissions policy/i.test(o));
  const geoDenied = (o: string): boolean => /code=1/.test(o);

  try {
    await expect
      .poll(() => lines.includes("E2E_PROBE ALL_DONE"), { timeout: 150_000, intervals: [200] })
      .toBe(true);

    console.log(`\n─── MCP-App permissions, measured ───`);
    for (const feature of ["camera", "microphone", "geolocation", "clipboardWrite"] as const) {
      console.log(
        `  ${feature.padEnd(15)} declared=${outcome("declared", feature)}\n` +
          `  ${" ".repeat(15)} absent  =${outcome("absent", feature)}\n` +
          `  ${" ".repeat(15)} mic-only=${outcome("mic-only", feature)}`,
      );
    }

    // Inner frames must report a non-opaque origin and the required sandbox pair.
    for (const label of ["declared", "absent", "revoked", "mic-only"]) {
      expect(lines).toContain(`E2E_PROBE ${label} OPAQUE_ORIGIN:false`);
      expect(frame(label).sandbox).toBe("allow-scripts allow-same-origin");
    }

    // Delegate only host-supported declared capabilities; absent declarations get no allow attribute.
    expect(frame("declared").allow).toBe("camera; microphone; geolocation");
    expect(frame("declared").meta).toBe("camera; microphone; geolocation");
    expect(frame("absent").allow).toBeNull();
    expect(frame("absent").meta).toBeNull();
    expect(frame("mic-only").allow).toBe("microphone");
    expect(frame("mic-only").meta).toBe("microphone");

    expect(mediaGranted(outcome("declared", "camera"))).toBe(true);
    expect(mediaGranted(outcome("declared", "microphone"))).toBe(true);
    expect(geoGranted(outcome("declared", "geolocation"))).toBe(true);

    // Identical documents differ only in declaration, isolating the policy-layer denial.
    expect(mediaDenied(outcome("absent", "camera"))).toBe(true);
    expect(mediaDenied(outcome("absent", "microphone"))).toBe(true);
    expect(geoDenied(outcome("absent", "geolocation"))).toBe(true);

    // Revoke the session after policy delegation so denial proves the runtime handler is installed.
    expect(lines).toContain("E2E_PROBE revoked SESSION_REVOKED");
    expect(frame("revoked").allow).toBe("camera; microphone; geolocation");
    expect(mediaDenied(outcome("revoked", "camera"))).toBe(true);
    expect(mediaDenied(outcome("revoked", "microphone"))).toBe(true);
    expect(geoDenied(outcome("revoked", "geolocation"))).toBe(true);

    // Media kinds share one runtime permission; enforce microphone-only grants in the request handler.
    expect(mediaGranted(outcome("mic-only", "microphone"))).toBe(true);
    expect(mediaDenied(outcome("mic-only", "camera"))).toBe(true);
    expect(geoDenied(outcome("mic-only", "geolocation"))).toBe(true);

    // Clipboard writes remain unavailable and must be denied on every card.
    for (const label of ["declared", "absent", "revoked", "mic-only"] as const) {
      expect(outcome(label, "clipboardWrite")).toMatch(/^fail:/);
    }

    expect(lines.join("\n")).not.toContain("BRIDGE_CONNECT_FAILED");
  } finally {
    console.log(`\n─── raw markers ───\n${lines.join("\n")}\n`);
    await app.close().catch(() => {});
  }
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile, writeFile, mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { spawnSync, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { buildImagePreparationEntry, imageFixturePath } from "../../__tests__/support/image-preparation-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { buildMainBoundaryBundle, childBundleDir, repositoryRoot } from "../../plugins/isolation/__tests__/child-entry-bundle.js";
import { IMAGE_PREPARATION_POLICY, ImagePreparationOptionsSchema, ImagePreparationRequestSchema, type ImagePreparationOptions } from "../../shared/image-preparation-policy.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import * as managed from "../../main/managed-child-processes.js";
import { configureHostResources } from "../../main/host-resources.js";
import { projectSubscriptionImageHistory } from "../../main/subscription-image-history.js";
import { MAX_ACP_SUBSCRIPTION_IMAGE_BYTES } from "../../main/acp-subscription-session-client.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { sealTargets } from "../../permissions/target-seal.js";
import { ToolExecutor } from "../executor.js";
import { ViewImageTool } from "../file-tools.js";
import { ToolRegistry } from "../registry.js";

const runtime = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../main/main-paths.js", async (original) => ({
  ...await original<typeof import("../../main/main-paths.js")>(),
  get mainDir() { return runtime.directory; },
}));
import { prepareImageBytes, prepareImageFile } from "../image-preparation.js";
import { normalizeImage } from "../image-preparation-core.js";

function prepareFixtureImage(path: string, options: Partial<ImagePreparationOptions> = {}, signal?: AbortSignal) {
  return prepareImageFile(path, { cwd: repositoryRoot(), extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true }, options, signal);
}

let directory: string;
function observeNextImageChild(): Promise<ChildProcess> {
  const original = managed.spawnManaged;
  return new Promise((resolve) => {
    vi.spyOn(managed, "spawnManaged").mockImplementationOnce((...args) => {
      const child = original(...args); resolve(child); return child;
    });
  });
}

async function useStalledImageRuntime(): Promise<void> {
  const stalled = join(directory, "stalled"); await mkdir(stalled, { recursive: true });
  await writeFile(join(stalled, "image-preparation-child.js"), "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  runtime.directory = stalled;
}
beforeAll(async () => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  directory = await buildImagePreparationEntry("image-preparation-runtime");
  runtime.directory = directory;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); runtime.directory = directory; });
afterAll(async () => { await cleanupTmpDir(directory); });

describe("bounded image preparation", () => {
  it("normalizes broker-returned bytes through the isolated decoder stdin", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      const source = await readFile(imageFixturePath(`grid.${format}`));
      const result = await prepareImageBytes(source, { maxDimension: 4 });
      expect(result).toMatchObject({
        originalFormat: format,
        width: 4,
        height: 2,
        inputBytes: source.byteLength,
      });
      expect((await sharp(Buffer.from(result.data, "base64")).metadata()).format).toBe("png");
    }
  });

  it("copies broker-returned bytes before admission and rejects oversized input before spawning", async () => {
    const source = await readFile(imageFixturePath("grid.png"));
    const expectedBytes = source.byteLength;
    const prepared = prepareImageBytes(source, { maxDimension: 2 });
    source.fill(0);
    expect(await prepared).toMatchObject({ width: 2, inputBytes: expectedBytes });

    const spawn = vi.spyOn(managed, "spawnManaged");
    await expect(prepareImageBytes(Buffer.alloc(IMAGE_PREPARATION_POLICY.maxInputBytes + 1)))
      .rejects.toThrow("image-input-limit");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fully decodes each supported source format in a child and preserves transparency", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      const result = await prepareFixtureImage(imageFixturePath(`grid.${format}`), { maxDimension: 4 });
      const decoded = await sharp(Buffer.from(result.data, "base64")).raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info).toMatchObject({ width: 4, height: 2 });
      expect(result.originalFormat).toBe(format);
      if (format === "png") expect(decoded.info.channels).toBe(4);
    }
  });

  it("corrects EXIF orientation and reports original and displayed dimensions", async () => {
    const result = await prepareFixtureImage(imageFixturePath("oriented.jpeg"));
    expect(result).toMatchObject({ originalWidth: 8, originalHeight: 4, width: 4, height: 8, orientationApplied: true, resized: false });
    expect((await sharp(Buffer.from(result.data, "base64")).metadata()).orientation).toBeUndefined();
  });

  it("reports selecting the first frame without stacking animated frames", async () => {
    const result = await prepareFixtureImage(imageFixturePath("animated.gif"));
    expect(result).toMatchObject({ frame: 0, frameCount: 2, width: 8, height: 4 });
    expect((await sharp(Buffer.from(result.data, "base64")).metadata()).pages).toBeUndefined();
  });

  it("fits a caller byte budget by reducing dimensions and errors when even one pixel cannot fit", async () => {
    const result = await prepareFixtureImage(imageFixturePath("grid.png"), { maxBytes: 100 });
    expect(result.bytes).toBeLessThanOrEqual(100);
    expect(result.resized).toBe(true);
    expect((await sharp(Buffer.from(result.data, "base64")).metadata()).width).toBe(result.width);
    await expect(prepareFixtureImage(imageFixturePath("grid.png"), { maxBytes: 1 })).rejects.toThrow("image-output-limit");
  });

  it("rejects an input pixel bomb before producing an image", async () => {
    const source = await sharp({ create: { width: 4096, height: 4097, channels: 3, background: "red" } }).png().toBuffer();
    expect(source.length).toBeLessThan(IMAGE_PREPARATION_POLICY.maxInputBytes);
    await expect(normalizeImage(source, ImagePreparationOptionsSchema.parse({}))).rejects.toThrow(/pixel/i);
  });

  it("rejects corruption after a valid format header", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"]) {
      const source = await readFile(imageFixturePath(`grid.${format}`));
      await expect(normalizeImage(source.subarray(0, 16), ImagePreparationOptionsSchema.parse({}))).rejects.toThrow();
    }
  });

  it("rejects caller attempts to raise host ceilings", () => {
    expect(ImagePreparationOptionsSchema.safeParse({ maxBytes: IMAGE_PREPARATION_POLICY.maxOutputBytes + 1 }).success).toBe(false);
    expect(ImagePreparationOptionsSchema.safeParse({ maxDimension: IMAGE_PREPARATION_POLICY.maxDimension + 1 }).success).toBe(false);
    expect(ImagePreparationRequestSchema.safeParse({ path: imageFixturePath("grid.png"), options: {} }).success).toBe(false);
  });

  it("rechecks the frozen invocation read scope inside the decoder process", async () => {
    const path = imageFixturePath("grid.png");
    await expect(prepareImageFile(path, {
      cwd: directory, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true,
    })).rejects.toThrow("Sandbox");
    const extraAllowedDirectories = [dirname(path)];
    const admitted = prepareImageFile(path, {
      cwd: directory, extraAllowedDirectories, blockReadsOutsideWorkingDirectories: true,
    });
    extraAllowedDirectories.length = 0;
    expect((await admitted).width).toBe(8);
  });

  it.skipIf(process.platform === "win32")("denies a missing out-of-scope image before native source resolution", async () => {
    const cwd = join(directory, "allowed-image-directory");
    await mkdir(cwd);
    await expect(prepareImageFile(join(directory, "missing-out-of-scope.png"), {
      cwd, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true,
    })).rejects.toThrow(/^invalid-image: Sandbox:/);
  });

  it.skipIf(process.platform === "win32")("decodes the sealed image through a symlink target containing dot-dot", async () => {
    const root = join(directory, "posix-image-links");
    const actual = join(root, "actual");
    await mkdir(join(actual, "nested"), { recursive: true });
    await writeFile(join(actual, "image.png"), await readFile(imageFixturePath("grid.png")));
    await writeFile(join(root, "image.png"), await sharp({
      create: { width: 3, height: 3, channels: 3, background: "red" },
    }).png().toBuffer());
    await symlink("actual/nested", join(root, "hop"));
    const path = join(root, "alias.png");
    await symlink("hop/../image.png", path);
    const approved = realpathSync.native(join(actual, "image.png"));
    expect(realpathSync.native(path)).toBe(approved);
    const seal = sealTargets(() => realpathSync.native(path));

    const result = await prepareImageFile(path, {
      cwd: root, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true,
    }, {}, undefined, seal, approved);
    expect(result).toMatchObject({ originalWidth: 8, originalHeight: 4 });
  });

  it("does not open an in-scope replacement selected during decoder spawn", async () => {
    const original = join(directory, "original");
    const replacement = join(directory, "replacement");
    const alias = join(directory, "alias");
    await mkdir(original);
    await mkdir(replacement);
    const bytes = await readFile(imageFixturePath("grid.png"));
    await writeFile(join(original, "image.png"), bytes);
    await writeFile(join(replacement, "image.png"), bytes);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(original, alias, linkType);
    const path = join(alias, "image.png");
    const approved = realpathSync.native(path);
    const seal = sealTargets(() => realpathSync.native(path));
    const marker = join(directory, "replacement-opened");
    const trace = join(directory, "trace-open.mjs");
    await writeFile(trace, `
      import fs from "node:fs";
      import fsPromises from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const open = fsPromises.open;
      fsPromises.open = (path, ...args) => {
        if (path === ${JSON.stringify(realpathSync.native(join(replacement, "image.png")))}) {
          fs.writeFileSync(${JSON.stringify(marker)}, "opened");
        }
        return open(path, ...args);
      };
      syncBuiltinESMExports();
    `);
    const spawn = managed.spawnManaged;
    vi.spyOn(managed, "spawnManaged").mockImplementationOnce((program, args, ...options) => {
      unlinkSync(alias);
      symlinkSync(replacement, alias, linkType);
      return spawn(program, ["--import", pathToFileURL(trace).href, ...args], ...options);
    });
    const result = prepareImageFile(path, {
      cwd: directory, extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true,
    }, {}, undefined, seal, approved);
    const error = await result.catch((failure: unknown) => failure);
    expect(existsSync(marker)).toBe(false);
    expect(error).toEqual(expect.objectContaining({ message: expect.stringContaining("Target identity changed") }));
    await unlink(alias);
  });

  it("recovers from an active transport delivery limit by requesting a smaller real image", async () => {
    const pixels = Buffer.alloc(512 * 512 * 3);
    let state = 17;
    for (let index = 0; index < pixels.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      pixels[index] = state & 255;
    }
    const path = join(directory, "detailed.png");
    await writeFile(path, await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer());
    const limits = { maxCount: 1, maxBytesPerImage: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES, maxTotalBytes: MAX_ACP_SUBSCRIPTION_IMAGE_BYTES };
    const initial = await prepareFixtureImage(path);
    const message: GenericMessage = { role: "tool_result", toolUseId: "first-image", toolName: "view_image", content: "Loaded image", image: initial };
    expect(initial.bytes).toBeGreaterThan(limits.maxBytesPerImage);
    expect(projectSubscriptionImageHistory([message], limits)[0]).toMatchObject({ isError: true, content: expect.stringContaining("Image delivery failed") });
    const retry = await prepareFixtureImage(path, { maxBytes: limits.maxBytesPerImage });
    const delivered = projectSubscriptionImageHistory([{ ...message, toolUseId: "smaller-image", image: retry }], limits);
    expect(delivered[0]).toMatchObject({ image: { data: retry.data } });
    expect(delivered[0]).not.toHaveProperty("isError");
    expect((await sharp(Buffer.from(retry.data, "base64")).raw().toBuffer({ resolveWithObject: true })).info.width).toBe(retry.width);
    expect(message.image).toBe(initial);
  });

  it("does not start a child for an already cancelled request", async () => {
    const spawn = vi.spyOn(managed, "spawnManaged");
    const controller = new AbortController(); controller.abort();
    await expect(prepareFixtureImage(imageFixturePath("grid.png"), {}, controller.signal)).rejects.toThrow("image-cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("cancels a stalled native lookup in the decoder", async () => {
    const path = imageFixturePath("grid.png");
    const preload = join(directory, "stall-realpath.mjs");
    await writeFile(preload, `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const realpath = fs.realpath;
      fs.realpath = async (path, ...args) => {
        if (path === ${JSON.stringify(path)}) {
          process.stderr.write("lookup-stalled");
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
        return realpath(path, ...args);
      };
      syncBuiltinESMExports();
    `);
    const hostLookup = vi.spyOn(realpathSync, "native");
    const controller = new AbortController();
    const spawn = managed.spawnManaged;
    let diagnostics = "";
    let closed = false;
    vi.spyOn(managed, "spawnManaged").mockImplementationOnce((program, args, ...options) => {
      const child = spawn(program, ["--import", pathToFileURL(preload).href, ...args], ...options);
      child.stderr?.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString();
        if (diagnostics.includes("lookup-stalled")) controller.abort();
      });
      child.once("close", () => { closed = true; });
      return child;
    });

    await expect(prepareFixtureImage(path, {}, controller.signal)).rejects.toThrow("image-cancelled");
    expect(hostLookup.mock.calls.filter(([operand]) => operand === path)).toEqual([]);
    expect(diagnostics).toContain("lookup-stalled");
    expect(closed).toBe(true);
  });

  it.skipIf(process.platform === "win32")("cancels a sealed image invocation during its final native lookup", async () => {
    const path = imageFixturePath("grid.png");
    const expectedPath = realpathSync.native(path);
    const preload = join(directory, "stall-final-realpath.mjs");
    await writeFile(preload, `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const realpath = fs.realpath;
      let lookups = 0;
      fs.realpath = async (path, ...args) => {
        if (path === ${JSON.stringify(path)} && ++lookups === 2) {
          process.stderr.write("final-lookup-stalled");
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
        return realpath(path, ...args);
      };
      syncBuiltinESMExports();
    `);
    const controller = new AbortController();
    const hostLookup = vi.spyOn(realpathSync, "native");
    const spawn = managed.spawnManaged;
    let request: unknown;
    let lookupCountAtSpawn = 0;
    let closed = false;
    let diagnostics = "";
    vi.spyOn(managed, "spawnManaged").mockImplementationOnce((program, args, ...options) => {
      request = JSON.parse(args[1]!);
      lookupCountAtSpawn = hostLookup.mock.calls.filter(([operand]) => operand === path).length;
      const child = spawn(program, ["--import", pathToFileURL(preload).href, ...args], ...options);
      child.stderr?.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString();
        if (diagnostics.includes("final-lookup-stalled")) controller.abort();
      });
      child.once("close", () => { closed = true; });
      return child;
    });

    const tool = new ViewImageTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const permissions = new PermissionManager(join(directory, "image-permissions.json"));
    permissions.setMode("allow");
    const audit = new AuditLogger(join(directory, "image-audit"));
    try {
      const executor = new ToolExecutor(registry, undefined, permissions, undefined, undefined, undefined, audit);
      const [result] = await executor.executeAll([{ id: "sealed-image", name: tool.name, input: { path } }], {
        executionCwd: repositoryRoot(),
        sessionId: "sealed-image",
        permissionContext: { trustOrigin: "llm-tool-arg", approvalSurface: "unavailable" },
        abortSignal: controller.signal,
      });

      expect(request).toMatchObject({ path, expectedPath });
      expect(hostLookup.mock.calls.filter(([operand]) => operand === path)).toHaveLength(lookupCountAtSpawn);
      expect(diagnostics).toContain("final-lookup-stalled");
      expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/cancelled/i) });
      expect(result).not.toHaveProperty("image");
      expect(closed).toBe(true);
    } finally {
      await audit.close();
    }
  });

  it("waits for child termination on cancellation, then admits a queued request", async () => {
    const ready = observeNextImageChild();
    const controller = new AbortController();
    const first = prepareFixtureImage(imageFixturePath("grid.png"), {}, controller.signal);
    const rejection = expect(first).rejects.toThrow("image-cancelled");
    const firstChild = await ready;
    const second = prepareFixtureImage(imageFixturePath("grid.png"), { maxDimension: 2 });
    controller.abort();
    await rejection;
    expect(firstChild.exitCode !== null || firstChild.signalCode !== null).toBe(true);
    expect((await second).width).toBe(2);
  });

  it("includes native processing in the total deadline and reclaims the child", async () => {
    await useStalledImageRuntime();
    const ready = observeNextImageChild();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = prepareFixtureImage(imageFixturePath("grid.png"));
    const rejection = expect(request).rejects.toThrow("image-processing-timeout");
    const child = await ready;
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.imagePreparationMs);
    await rejection;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("bounds the waiting queue and removes cancelled requests before reading or spawning", async () => {
    await useStalledImageRuntime();
    const ready = observeNextImageChild();
    const controller = new AbortController();
    const first = prepareFixtureImage(imageFixturePath("grid.png"), {}, controller.signal).catch((error: Error) => error.message);
    await ready;
    const controllers = Array.from({ length: IMAGE_PREPARATION_POLICY.queuedJobs }, () => new AbortController());
    const queued = controllers.map((item) => prepareFixtureImage("must-not-be-read.png", {}, item.signal).catch((error: Error) => error.message));
    await expect(prepareFixtureImage(imageFixturePath("grid.png"))).rejects.toThrow("image-busy");
    for (const item of controllers) item.abort();
    expect(await Promise.all(queued)).toEqual(controllers.map(() => "image-cancelled: Image preparation was cancelled."));
    controller.abort();
    expect(await first).toContain("image-cancelled");
  });

  it("reports a missing decoder installation and releases admission for the next request", async () => {
    runtime.directory = join(directory, "missing");
    await expect(prepareFixtureImage(imageFixturePath("grid.png"))).rejects.toThrow("image-processing-unavailable");
    runtime.directory = directory;
    expect((await prepareFixtureImage(imageFixturePath("grid.png"))).width).toBe(8);
  });

  it("rejects an oversized child response without keeping the process alive", async () => {
    const excessive = join(directory, "excessive"); await mkdir(excessive, { recursive: true });
    await writeFile(join(excessive, "image-preparation-child.js"), "process.stdin.resume(); process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000);\n");
    runtime.directory = excessive;
    await expect(prepareFixtureImage(imageFixturePath("grid.png"), { maxBytes: 1 })).rejects.toThrow("image-response-limit");
  });

  it("refuses to read when the decoder is started without the host resources", () => {
    const request = ImagePreparationRequestSchema.parse({
      path: imageFixturePath("grid.png"), options: {},
      expectedPath: realpathSync.native(imageFixturePath("grid.png")),
      scope: { cwd: repositoryRoot(), extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true },
    });
    const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    const result = spawnSync(node, [join(directory, "image-preparation-child.js"), JSON.stringify(request)], {
      encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.imagePreparationMs, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, error: expect.stringMatching(/^image-processing-unavailable: host-resources-unavailable:/) });
  });

  it("runs the complete file-to-decoder flow under the standalone runtime", async () => {
    const outdir = childBundleDir("image-preparation-standalone");
    try {
      await buildMainBoundaryBundle({ entryPoints: {
        "image-client": join(repositoryRoot(), "src/tools/image-preparation.ts"),
        "host-resources": join(repositoryRoot(), "src/main/host-resources.ts"),
      }, outdir, splitting: true });
      await buildImagePreparationEntry("image-preparation-standalone");
      const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
      const result = spawnSync(node, ["--input-type=module", "-e", `
        import { prepareImageFile } from ${JSON.stringify(pathToFileURL(join(outdir, "image-client.mjs")).href)};
        import { configureHostResources } from ${JSON.stringify(pathToFileURL(join(outdir, "host-resources.mjs")).href)};
        configureHostResources({ resourcePath: ${JSON.stringify(resolve("resources"))}, isPackaged: false });
        const image = await prepareImageFile(process.argv[1], { cwd: process.argv[2], extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true }, { maxDimension: 2, maxBytes: 512 });
        process.stdout.write(JSON.stringify({ image, electron: process.versions.electron ?? null }));
      `, imageFixturePath("grid.png"), repositoryRoot()], { encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.imagePreparationMs, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      expect(result.status, result.stderr).toBe(0);
      const response = JSON.parse(result.stdout);
      expect(response.electron).toBeNull();
      expect(response.image).toMatchObject({ width: 2, height: 1 });
    } finally { await cleanupTmpDir(outdir); }
  });
});

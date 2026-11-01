import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class MxcIntegrityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MxcIntegrityError";
  }
}

// Installation files belong to the signed-in user. Verification detects drift,
// but cannot protect against that user racing replacement during native loading.
export function verifyMxcSdk(nodeModules, arch, pins, environment = process.env, strictNativeDirectories = false) {
  if (!path.isAbsolute(nodeModules) || !Object.hasOwn(pins.sdk.architectures, arch)) {
    throw new MxcIntegrityError("Unsupported SDK installation or architecture");
  }
  for (const key of Object.keys(environment)) {
    if (/^(MXC_FFI_DIR|NODE_OPTIONS|NODE_PATH)$/i.test(key) && environment[key] !== undefined) {
      throw new MxcIntegrityError(`Native loader override refused: ${key}`);
    }
  }
  const entries = { ...pins.sdk.files, ...pins.sdk.architectures[arch] };
  try {
    const root = realpathSync(nodeModules);
    for (const [relative, expected] of Object.entries(entries)) {
      const file = path.join(root, ...relative.split("/"));
      const resolved = realpathSync(file);
      if (resolved !== file || !lstatSync(file).isFile()) {
        throw new MxcIntegrityError(`Native payload path redirected: ${relative}`);
      }
      const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
      if (digest !== expected) throw new MxcIntegrityError(`Native payload hash mismatch: ${relative}`);
    }
    const sdkRoot = path.join(root, "@microsoft", "mxc-sdk");
    const require = createRequire(pathToFileURL(path.join(sdkRoot, "package.json")));
    for (const [name, version] of Object.entries(pins.sdk.versions)) {
      const file = path.join(root, ...name.split("/"), "package.json");
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name !== name || pkg.version !== version) throw new MxcIntegrityError(`Runtime resolution mismatch: ${name}`);
      const entry = require.resolve(name);
      const relativeEntry = path.relative(root, entry).split(path.sep).join("/");
      if (!entry.startsWith(path.join(root, ...name.split("/")) + path.sep) || !Object.hasOwn(entries, relativeEntry)) {
        throw new MxcIntegrityError(`Runtime resolution redirected: ${name}`);
      }
    }
    const addonPackage = `@koromix/koffi-win32-${arch}`;
    const addonRoot = path.join(root, "@koromix", `koffi-win32-${arch}`);
    const addonRequire = createRequire(pathToFileURL(path.join(root, "koffi", "package.json")));
    if (addonRequire.resolve(addonPackage) !== path.join(addonRoot, "index.js")) {
      throw new MxcIntegrityError("Native addon resolution redirected");
    }
    // These are the only directories registered for native dependency search.
    const nativeDirectories = [path.join(sdkRoot, "bin", arch), path.join(addonRoot, `win32_${arch}`)];
    for (const directory of nativeDirectories) {
      for (const name of readdirSync(directory)) {
        if (!strictNativeDirectories && !/\.(dll|node)$/i.test(name)) continue;
        const relative = path.relative(root, path.join(directory, name)).split(path.sep).join("/");
        if (!lstatSync(path.join(directory, name)).isFile() || !Object.hasOwn(entries, relative)) throw new MxcIntegrityError(`Unexpected native payload: ${relative}`);
      }
    }
    return { sdkRoot, nativeDirectories, addonPath: path.join(addonRoot, `win32_${arch}`, "koffi.node") };
  } catch (error) {
    if (error instanceof MxcIntegrityError) throw error;
    throw new MxcIntegrityError("Native SDK verification failed", { cause: error });
  }
}

export function verifyMxcSupervisorRuntime(executable, resources, arch) {
  try {
    if (!["x64", "arm64"].includes(arch) || !path.isAbsolute(executable) || !path.isAbsolute(resources)) {
      throw new MxcIntegrityError("Invalid supervisor runtime installation");
    }
    const manifest = JSON.parse(readFileSync(path.join(resources, "mxc", arch, "supervisor-runtime-pins.json"), "utf8"));
    if (manifest.version !== 1 || manifest.arch !== arch || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
      || !Object.hasOwn(manifest.files, path.basename(executable))) throw new MxcIntegrityError("Invalid supervisor runtime pins");
    const directory = path.dirname(realpathSync(executable));
    const modules = [];
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (path.basename(name) !== name || !/\.(exe|dll)$/i.test(name) || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
        throw new MxcIntegrityError("Invalid supervisor runtime pin entry");
      }
      const file = path.join(directory, name);
      if (realpathSync(file) !== file || !lstatSync(file).isFile()
        || createHash("sha256").update(readFileSync(file)).digest("hex") !== expected) {
        throw new MxcIntegrityError(`Supervisor runtime mismatch: ${name}`);
      }
      modules.push(file);
    }
    for (const name of readdirSync(directory)) {
      if (/\.dll$/i.test(name) && !Object.hasOwn(manifest.files, name)) throw new MxcIntegrityError(`Unexpected supervisor runtime DLL: ${name}`);
    }
    return modules;
  } catch (error) {
    if (error instanceof MxcIntegrityError) throw error;
    throw new MxcIntegrityError("Supervisor runtime verification failed", { cause: error });
  }
}

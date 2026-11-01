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

// The installed tree is administrator-writable. A developer checkout does not
// protect against concurrent mutation between verification and native loading.
export function verifyMxcSdk(nodeModules, arch, pins, environment = process.env) {
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
      if (require.resolve(`${name}/package.json`) !== file) throw new MxcIntegrityError(`Runtime resolution redirected: ${name}`);
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
        if (!/\.(dll|node)$/i.test(name)) continue;
        const relative = path.relative(root, path.join(directory, name)).split(path.sep).join("/");
        if (!Object.hasOwn(entries, relative)) throw new MxcIntegrityError(`Unexpected native payload: ${relative}`);
      }
    }
    return { sdkRoot, nativeDirectories, addonPath: path.join(addonRoot, `win32_${arch}`, "koffi.node") };
  } catch (error) {
    if (error instanceof MxcIntegrityError) throw error;
    throw new MxcIntegrityError("Native SDK verification failed", { cause: error });
  }
}

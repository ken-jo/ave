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

// These source-build directories are removed wholesale from the PTY package.
export const PTY_SOURCE_BUILD_DIRECTORIES = ["build", "deps", "src", "third_party"];

export const PACKAGE_RUNTIME_FIELDS = ["name", "version", "main", "exports", "type", "imports"];

function assertPackageMetadata(bytes, relative, metadata) {
  const expected = metadata && Object.hasOwn(metadata, relative) ? metadata[relative] : undefined;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)
    || typeof expected.name !== "string" || typeof expected.version !== "string"
    || ["main", "type"].some((field) => Object.hasOwn(expected, field) && typeof expected[field] !== "string")
    || Object.keys(expected).some((field) => !PACKAGE_RUNTIME_FIELDS.includes(field))) {
    throw new MxcIntegrityError(`Missing or invalid package metadata pin: ${relative}`);
  }
  const actual = JSON.parse(bytes.toString("utf8"));
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new MxcIntegrityError(`Invalid runtime package manifest: ${relative}`);
  }
  for (const field of PACKAGE_RUNTIME_FIELDS) {
    // Conditions are selected in declaration order, so preserve object order.
    // An absent field also differs from an explicit null or empty value.
    if (Object.hasOwn(actual, field) !== Object.hasOwn(expected, field)
      || JSON.stringify(actual[field]) !== JSON.stringify(expected[field])) {
      throw new MxcIntegrityError(`Runtime package metadata mismatch: ${relative} (${field})`);
    }
  }
}

// Installation files belong to the signed-in user. Verification detects drift,
// but cannot protect against that user racing replacement during native loading.
export function verifyMxcSdk(nodeModules, arch, pins, environment = process.env, strictNativeDirectories = false) {
  if (!path.isAbsolute(nodeModules) || !Object.hasOwn(pins.sdk.architectures, arch)) {
    throw new MxcIntegrityError("Unsupported SDK installation or architecture");
  }
  for (const key of Object.keys(environment)) {
    if (/^(MXC_FFI_DIR|MXC_BIN_DIR|NODE_OPTIONS|NODE_PATH)$/i.test(key) && environment[key] !== undefined) {
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
      const bytes = readFileSync(file);
      if (relative.endsWith("/package.json")) {
        // Raw manifest hashes remain source/archive audit pins. Packaging may
        // remove build metadata, so installed manifests pin runtime fields only.
        assertPackageMetadata(bytes, relative, pins.sdk.packageMetadata);
        continue;
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== expected) throw new MxcIntegrityError(`Native payload hash mismatch: ${relative}`);
    }
    assertMxcSdkInventory(root, pins, strictNativeDirectories ? arch : undefined);
    const sdkRoot = path.join(root, "@microsoft", "mxc-sdk");
    const require = createRequire(pathToFileURL(path.join(sdkRoot, "package.json")));
    for (const [name, version] of Object.entries(pins.sdk.versions)) {
      const packageRoot = path.join(root, ...pins.sdk.packages[name].split("/"));
      const file = path.join(packageRoot, "package.json");
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.name !== name || pkg.version !== version) throw new MxcIntegrityError(`Runtime resolution mismatch: ${name}`);
      const requiredEntry = require.resolve(name);
      if (!requiredEntry.startsWith(packageRoot + path.sep)) throw new MxcIntegrityError(`Runtime resolution redirected: ${name}`);
      // Only exact root exports are used. Select in declaration order, matching
      // the runtime's node/import/default conditions; reject unsupported targets.
      const selectImport = (target) => {
        if (typeof target === "string") return target;
        if (!target || Array.isArray(target) || typeof target !== "object") throw new MxcIntegrityError("Unsupported import export target");
        for (const [condition, value] of Object.entries(target)) {
          if (["node", "node-addons", "import", "default"].includes(condition)) return selectImport(value);
        }
        throw new MxcIntegrityError("No supported import export target");
      };
      const target = pkg.exports === undefined ? (pkg.main ?? "index.js")
        : selectImport(Object.hasOwn(pkg.exports, ".") ? pkg.exports["."] : pkg.exports);
      const entry = path.resolve(packageRoot, target);
      const relativeEntry = path.relative(root, entry).split(path.sep).join("/");
      if (!entry.startsWith(packageRoot + path.sep) || !Object.hasOwn(entries, relativeEntry)) {
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

// These upstream backends are present in the installed archive but are never
// loaded by the extension path and are removed from the packaged native bin.
export const SDK_INSTALLATION_AUXILIARIES = new Set([
  "libmxc_ffi.so", "libmxc_ffi.dylib", "lxc-exec", "mxc-exec-mac", "unix-test-proxy",
  "mxc-diagnostic-console.exe", "plm.exe", "winhttp-proxy-shim.exe", "wxc-exec.exe",
  "wxc-host-prep.exe", "wxc-test-proxy.exe", "wxc-windows-sandbox-daemon.exe",
  "wxc-windows-sandbox-guest.exe", "wxc-wslc-daemon.exe",
]);

export function assertMxcSdkInventory(nodeModules, pins, arch) {
  if (arch !== undefined) {
    if (!Object.hasOwn(pins.sdk.architectures, arch)) throw new MxcIntegrityError("Unsupported SDK installation or architecture");
    return assertPackagedInventory(nodeModules, arch, pins);
  }
  const sdkRoot = path.join(nodeModules, "@microsoft", "mxc-sdk");
  const pinned = new Set([...Object.keys(pins.sdk.files), ...Object.values(pins.sdk.architectures).flatMap(Object.keys)]);
  const semverRoot = pins.sdk.packages.semver.replace(/^@microsoft\/mxc-sdk\//, "");
  const allowed = (relative) => pinned.has("@microsoft/mxc-sdk/" + relative)
    || ["README.md", "LICENSE.md"].includes(relative)
    || (semverRoot && ["LICENSE", "README.md", "range.bnf"].some((name) => relative === semverRoot + "/" + name))
    || /^dist\/.+\.(?:d\.ts(?:\.map)?|js\.map)$/.test(relative)
    || /^bin\/(?:x64|arm64)\/dotnet\/NativeMethods\.g\.cs$/.test(relative)
    || /^bin\/(?:x64|arm64)\/_manifest\/.+\.(?:json(?:\.sha256)?|cose|cat)$/.test(relative)
    || (/^bin\/(?:x64|arm64)\/[^/]+$/.test(relative) && SDK_INSTALLATION_AUXILIARIES.has(relative.split("/").at(-1)));
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory)) {
      const relative = prefix + name, file = path.join(directory, name);
      const entry = lstatSync(file);
      if (/^node_modules\/\.bin\/semver(?:\.(?:cmd|ps1|exe|bunx))?$/.test(relative)) {
        if (entry.isDirectory() || (entry.isSymbolicLink() && realpathSync(file) !== realpathSync(path.join(sdkRoot, semverRoot, "bin", "semver.js")))) {
          throw new MxcIntegrityError(`SDK command shim redirected: ${relative}`);
        }
        continue;
      }
      if (entry.isSymbolicLink()) throw new MxcIntegrityError(`SDK inventory path redirected: ${relative}`);
      if (entry.isDirectory()) walk(file, relative + "/");
      else if (!entry.isFile() || !allowed(relative)) throw new MxcIntegrityError(`Unexpected installed SDK file: @microsoft/mxc-sdk/${relative}`);
    }
  };
  walk(sdkRoot);
}

// Source verification retains archive byte identity before packaging rewrites manifests.
export function verifyMxcSdkSource(nodeModules, arch, pins, environment = process.env) {
  const verified = verifyMxcSdk(nodeModules, arch, pins, environment);
  for (const [relative, expected] of Object.entries({ ...pins.sdk.files, ...pins.sdk.architectures[arch] })) {
    if (!relative.endsWith("/package.json")) continue;
    const digest = createHash("sha256").update(readFileSync(path.join(nodeModules, relative))).digest("hex");
    if (digest !== expected) throw new MxcIntegrityError(`Source package manifest hash mismatch: ${relative}`);
  }
  return verified;
}

function assertPackagedInventory(nodeModules, arch, pins) {
  const pinned = new Set(Object.keys({ ...pins.sdk.files, ...pins.sdk.architectures[arch] }));
  const roots = new Set([
    ...Object.values(pins.sdk.packages),
    `@koromix/koffi-win32-${arch}`,
  ]);
  const allowed = (relative) => {
    if (pinned.has(relative)) return true;
    if (["@microsoft/mxc-sdk/LICENSE.md", "@microsoft/mxc-sdk/README.md"].includes(relative)) return true;
    // Non-runtime documentation, declarations and native build sources have
    // scoped extension rules. Manifests, scripts and binaries always need pins.
    if (/^(?:koffi|node-pty)\/(?:LICENSE(?:\.(?:md|txt))?|README\.md|CHANGELOG\.md)$/.test(relative)) return true;
    if (/^koffi\/(?:src|lib|vendor)\/.+\.(?:cc|hh|h|inc|S|asm|def)$/.test(relative)) return true;
    if (/^koffi\/src\/koffi\/CMakeLists\.txt$/.test(relative)) return true;
    if (/^koffi\/vendor\/[^\/]+\/(?:LICENSE(?:\.(?:md|txt))?|README\.md)$/.test(relative)) return true;
    if (/^(?:koffi\/index|node-pty\/typings\/node-pty)\.d\.ts$/.test(relative)) return true;
    if (/^node-pty\/binding\.gyp$/.test(relative)) return true;
    const semver = pins.sdk.packages.semver;
    return ["LICENSE", "README.md", "range.bnf"].some((name) => relative === semver + "/" + name)
      || /^@microsoft\/mxc-sdk\/dist\/.+\.(?:d\.ts(?:\.map)?|js\.map)$/.test(relative);
  };
  const walk = (relative) => {
    const file = path.join(nodeModules, relative);
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || realpathSync(file) !== file) throw new MxcIntegrityError(`Packaged inventory path redirected: ${relative}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(file)) walk(relative + "/" + name);
    } else if (!entry.isFile() || !allowed(relative)) {
      throw new MxcIntegrityError(`Unexpected packaged SDK file: ${relative}`);
    }
  };
  for (const root of roots) walk(root);
}

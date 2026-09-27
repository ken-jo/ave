import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDocumentationPath } from "../hooks/pre-push-markdown-policy.mjs";
import { guardedNodeOptions } from "./document-consumer-node-options.mjs";
import { withoutGitContext } from "./git-process-environment.mjs";

const DOCUMENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const PACKAGE_PLATFORMS = ["mac", "win", "linux"];
const PACKAGE_ARCHES = {
  mac: ["x64", "arm64", "universal"],
  win: ["x64", "arm64", "ia32"],
  linux: ["x64", "arm64", "ia32", "armv7l"],
};
const PACKAGE_FIELDS = ["extraResources", "extraFiles", "files"];
function repositoryRelative(root, path) {
  const result = relative(root, path);
  if (result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    throw new Error(`[document-consumer] package source leaves the repository`);
  }
  return result.split(sep).join("/");
}

function repositoryPaths(input, root = DOCUMENT_ROOT) {
  let path = input;
  if (path instanceof URL) {
    if (path.protocol !== "file:") return [];
    path = fileURLToPath(path);
  } else if (Buffer.isBuffer(path)) {
    path = path.toString("utf8");
  }
  if (typeof path !== "string") return [];
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const paths = [absolute];
  try {
    paths.push(fs.realpathSync(absolute));
  } catch {
    // Missing inputs still need lexical classification before the file operation fails.
  }
  return paths.flatMap((candidate) => {
    const result = relative(root, candidate);
    if (!result || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) return [];
    return [result.split(sep).join("/")];
  });
}

export function assertAllowedDocumentRead(input, root = DOCUMENT_ROOT) {
  for (const path of repositoryPaths(input, root)) {
    if (isDocumentationPath(path)) {
      throw new Error(`[document-consumer] ${path} reads documentation outside the consumed inventory`);
    }
  }
}

function assertAllowedDocumentCopy(input, root = DOCUMENT_ROOT) {
  for (const path of repositoryPaths(input, root)) {
    if (path === "docs" || path.startsWith("docs/")) {
      if (!/\.(?:md|html)$/i.test(path)) {
        throw new Error(`[document-consumer] ${path} can copy unlisted documentation`);
      }
      if (!path.includes("*") && isDocumentationPath(path)) {
        throw new Error(`[document-consumer] ${path} copies documentation outside the consumed inventory`);
      }
      if (path === "docs" || path.includes("*")) {
        throw new Error(`[document-consumer] ${path} can copy unlisted documentation`);
      }
    }
  }
  assertAllowedDocumentRead(input, root);
}

function sourceDocuments(root) {
  const realRoot = fs.realpathSync(root);
  const tracked = spawnSync("git", ["-C", root, "ls-files", "--stage", "-z", "--"], {
    encoding: "buffer", env: withoutGitContext(), maxBuffer: 64 * 1024 * 1024,
  });
  if (tracked.error || tracked.status !== 0) {
    throw new Error("[document-consumer] cannot enumerate tracked package sources");
  }
  const entries = new Map();
  for (const record of new TextDecoder("utf-8", { fatal: true }).decode(tracked.stdout).split("\0")) {
    if (!record) continue;
    const match = /^([0-7]{6}) [0-9a-f]+ 0\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("[document-consumer] unresolved tracked package source");
    if (!["100644", "100755", "120000"].includes(match[1])) {
      throw new Error(`[document-consumer] unsupported tracked package source: ${match[2]}`);
    }
    entries.set(match[2], match[1]);
  }
  const result = new Map();
  const add = (source, target) => {
    if (/\.(?:md|html)$/i.test(target)) result.set(source, target);
  };
  const resolvedTarget = (path) => {
    let real;
    try { real = fs.realpathSync(resolve(root, path)); }
    catch { throw new Error(`[document-consumer] unresolved package symlink: ${path}`); }
    return repositoryRelative(realRoot, real);
  };
  const expandDirectory = (alias, target, visited = new Set()) => {
    if (visited.has(target)) throw new Error(`[document-consumer] cyclic package symlink: ${alias}`);
    const nextVisited = new Set(visited).add(target);
    const prefix = target ? `${target}/` : "";
    for (const [path, mode] of entries) {
      if (!path.startsWith(prefix)) continue;
      const source = `${alias}/${path.slice(prefix.length)}`;
      if (mode === "120000") {
        const resolved = resolvedTarget(path);
        const stat = fs.statSync(resolve(root, path));
        if (stat.isDirectory()) expandDirectory(source, resolved, nextVisited);
        else {
          if (!entries.has(resolved)) throw new Error(`[document-consumer] untracked package symlink target: ${path}`);
          add(source, resolved);
        }
      } else {
        add(source, path);
      }
    }
  };
  for (const [path, mode] of entries) {
    if (mode === "120000") {
      const target = resolvedTarget(path);
      const stat = fs.statSync(resolve(root, path));
      if (stat.isDirectory()) expandDirectory(path, target);
      else {
        if (!entries.has(target)) throw new Error(`[document-consumer] untracked package symlink target: ${path}`);
        add(path, target);
      }
    } else {
      add(path, path);
    }
  }
  return [...result].map(([source, target]) => ({ source: resolve(root, source), target }));
}

export function packagedDocumentInputs(packageJson, root = DOCUMENT_ROOT) {
  const { getFileMatchers } = require("app-builder-lib/out/fileMatcher.js");
  const config = packageJson.build ?? {};
  const documents = sourceDocuments(root);
  const matched = new Set();
  for (const platform of PACKAGE_PLATFORMS) {
    for (const arch of PACKAGE_ARCHES[platform]) {
      const macroExpander = (value) => value.replace(/\$\{(arch|os|platform)\}/g, (_, name) =>
        name === "arch" ? arch : platform === "mac" ? "mac" : platform === "win" ? "win" : "linux");
      for (const field of PACKAGE_FIELDS) {
        const matchers = getFileMatchers(config, field, resolve(root, "release", field), {
          defaultSrc: root,
          macroExpander,
          customBuildOptions: config[platform] ?? {},
          globalOutDir: resolve(root, "release"),
        });
        if (!matchers && field === "files") {
          // An omitted files list packages the application directory by default.
          for (const { target } of documents) matched.add(target);
          continue;
        }
        for (const matcher of matchers ?? []) {
          const relativeSource = relative(root, matcher.from);
          if (relativeSource === ".." || relativeSource.startsWith(`..${sep}`) || isAbsolute(relativeSource)) {
            throw new Error(`[document-consumer] ${field} source leaves the repository`);
          }
          if (/\$\{/.test(matcher.from) || matcher.patterns.some((pattern) => /\$\{/.test(pattern))) {
            throw new Error(`[document-consumer] unsupported ${field} source macro`);
          }
          const fromStat = fs.existsSync(matcher.from) ? fs.statSync(matcher.from) : null;
          if (!fromStat) continue;
          if (fromStat.isDirectory() && (matcher.isEmpty() || matcher.containsOnlyIgnore())) {
            matcher.prependPattern("**/*");
          }
          const filter = matcher.createFilter();
          for (const { source: path, target } of documents) {
            if (fromStat.isFile()) {
              if (path === matcher.from) matched.add(target);
              continue;
            }
            const rel = relative(matcher.from, path);
            if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
            const segments = rel.split(sep);
            let allowed = true;
            for (let i = 1; i < segments.length; i += 1) {
              const directory = resolve(matcher.from, ...segments.slice(0, i));
              if (!filter(directory, fs.statSync(directory))) { allowed = false; break; }
            }
            if (allowed && filter(path, fs.statSync(path))) matched.add(target);
          }
        }
      }
    }
  }
  return [...matched].sort();
}

export function assertPackagedDocumentInputs(packageJson, root = DOCUMENT_ROOT) {
  const { consumed } = JSON.parse(fs.readFileSync(resolve(DOCUMENT_ROOT, "scripts/hooks/documentation-references.json"), "utf8"));
  const inventory = new Set(consumed);
  for (const path of packagedDocumentInputs(packageJson, root)) {
    if (!inventory.has(path)) {
      throw new Error(`[document-consumer] ${path} is packaged outside the consumed inventory`);
    }
  }
}

export function assertBundledDocumentInputs(paths, root = DOCUMENT_ROOT) {
  for (const path of paths) {
    assertAllowedDocumentRead(isAbsolute(path) ? path : resolve(root, path), root);
  }
}

export class DocumentDependencyPlugin {
  apply(compiler) {
    compiler.hooks.afterCompile.tap("DocumentDependencyPlugin", (compilation) => {
      assertBundledDocumentInputs(compilation.fileDependencies);
    });
  }
}

function installDocumentReadGuard(root = DOCUMENT_ROOT) {
  process.env.NODE_OPTIONS = guardedNodeOptions(process.env.NODE_OPTIONS);
  const installed = Symbol.for("ave.documentConsumerGuard");
  if (globalThis[installed]) return;
  globalThis[installed] = true;
  for (const name of ["readFileSync", "readFile", "createReadStream", "openSync", "open"]) {
    const original = fs[name];
    fs[name] = function (input, ...args) {
      assertAllowedDocumentRead(input, root);
      return original.call(this, input, ...args);
    };
  }
  for (const name of ["copyFileSync", "copyFile", "cpSync", "cp"]) {
    const original = fs[name];
    fs[name] = function (input, ...args) {
      assertAllowedDocumentCopy(input, root);
      return original.call(this, input, ...args);
    };
  }
  for (const name of ["readFile", "open", "copyFile", "cp"]) {
    const original = fsPromises[name];
    fsPromises[name] = async function (input, ...args) {
      (name === "copyFile" || name === "cp" ? assertAllowedDocumentCopy : assertAllowedDocumentRead)(input, root);
      return await original.call(this, input, ...args);
    };
  }
  syncBuiltinESMExports();
}

installDocumentReadGuard();

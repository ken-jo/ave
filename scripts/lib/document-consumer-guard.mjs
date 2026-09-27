import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDocumentationPath } from "../hooks/pre-push-markdown-policy.mjs";

const DOCUMENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

export function assertPackagedDocumentInputs(packageJson, root = DOCUMENT_ROOT) {
  for (const field of ["extraResources", "extraFiles", "files"]) {
    for (const entry of packageJson.build?.[field] ?? []) {
      const source = typeof entry === "string" ? entry : entry.from;
      if (typeof source !== "string" || source.startsWith("!")) continue;
      if (source === "." || source === "./" || source.startsWith("**")) {
        throw new Error(`[document-consumer] ${field} copies unlisted documentation`);
      }
      const absolute = resolve(root, source);
      assertAllowedDocumentCopy(absolute, root);
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

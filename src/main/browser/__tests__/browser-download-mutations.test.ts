import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { _descriptorFileOperationsForTest } from "../browser-download-files.js";

const RAW_MUTATION = /\b(?:unlink(?:at|Sync)?|rm(?:dir|dirSync|Sync)?|rename(?:at2?|atx_np|x_np|Sync|Exclusive|_into|Copy|At2)?|linuxRename|replaceStagedFile|DeleteFile\w*|MoveFile\w*|RemoveDirectory\w*|SetFileInformationByHandle|NtSetInformationFile|File(?:Disposition|Rename)Info\w*)\s*\(|\b(?:FileDispositionInfo(?:Ex)?|FileRenameInfo(?:Ex)?|FILE_(?:DISPOSITION|RENAME)_INFO(?:_EX)?)\b/gu;

function removeFunction(source: string, signature: string, indent = ""): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing mutation boundary: ${signature}`);
  const end = source.indexOf(`\n${indent}}\n`, start);
  if (end < 0) throw new Error(`missing end of mutation boundary: ${signature}`);
  return source.slice(0, start) + source.slice(end + indent.length + 2);
}

it("keeps native name changes inside the verified entry primitives", () => {
  const root = join(import.meta.dirname, "../../../..");
  const backendSources = [
    ["native/windows-path-kind", "dir-recovery.h", "inline FileFailure mutate_entry("],
    ["native/macos-dir-ops", "dir-ops.c", "static enum remove_result mutate_entry("],
  ] as const;
  const violations: string[] = [];
  const check = (relative: string, source: string) => {
    const code = source.replace(/^\s*\/\/[^\n]*/gmu, "");
    for (const match of code.matchAll(RAW_MUTATION)) {
      const before = code.lastIndexOf("\n", match.index);
      const after = code.indexOf("\n", match.index);
      violations.push(`${relative}: ${code.slice(before + 1, after < 0 ? undefined : after).trim()}`);
    }
  };
  for (const [directory, primitiveFile, signature] of backendSources) {
    for (const name of readdirSync(join(root, directory))) {
      if (!/\.(?:h|c|cpp)$/u.test(name) || name === "pin-test.cpp") continue;
      const relative = `${directory}/${name}`;
      let source = readFileSync(join(root, relative), "utf8").replaceAll("\r\n", "\n");
      if (name === primitiveFile) source = removeFunction(source, signature);
      if (directory === "native/macos-dir-ops" && name === "dir-ops.c") {
        source = removeFunction(source, "static void swap_file(");
      }
      check(relative, source);
    }
  }
  const linux = "src/main/browser/browser-download-files.ts";
  const source = readFileSync(join(root, linux), "utf8").replaceAll("\r\n", "\n");
  check(linux, removeFunction(source, "  function mutateEntry(", "  "));
  expect(violations).toEqual([]);
});

describe.runIf(process.platform === "linux")("an exclusive recovery rename races with a name replacement", () => {
  it.each([false, true])("keeps unrelated entries at the rollback boundary: %s", async (replaceBeforeRollback) => {
    const root = mkdtempSync(join(process.env.AVE_TEST_TMP_ROOT ?? process.cwd(), "download-rename-boundary-"));
    try {
      const hidden = `.${"a".repeat(32)}.removing`;
      const target = "target";
      const saved = join(root, "original");
      const displaced = join(root, "displaced");
      writeFileSync(join(root, hidden), "original");
      const folder = { path: root, ...statSync(root, { bigint: true }) };
      const stamp = statSync(join(root, hidden), { bigint: true });
      const files = _descriptorFileOperationsForTest((from, to) => {
        if (from === hidden && to === target) {
          renameSync(join(root, hidden), saved);
          writeFileSync(join(root, hidden), "first replacement");
        } else if (from === target && to === hidden && replaceBeforeRollback) {
          renameSync(join(root, target), displaced);
          writeFileSync(join(root, target), "second replacement");
        }
      });
      await expect(files.recoverTarget(folder, hidden, target, stamp)).resolves.toBe("left");
      expect(readFileSync(saved, "utf8")).toBe("original");
      if (replaceBeforeRollback) {
        expect(readFileSync(displaced, "utf8")).toBe("first replacement");
        expect(readFileSync(join(root, target), "utf8")).toBe("second replacement");
        expect(readdirSync(root)).not.toContain(hidden);
      } else {
        expect(readFileSync(join(root, hidden), "utf8")).toBe("first replacement");
        expect(readdirSync(root)).not.toContain(target);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The inventory records every literal reference to a tracked document.
// Only consumers of document bytes require the full test and build gate.
const { consumed } = JSON.parse(readFileSync(
  fileURLToPath(new URL("./documentation-references.json", import.meta.url)), "utf8"
));
const consumedDocuments = new Set(consumed);

export function isCanonicalGitPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) return false;
  if (relativePath.includes("\\") || relativePath.startsWith("/")) return false;
  if (/^[a-z]:\//i.test(relativePath) || /[\u0000-\u001f\u007f-\u009f]/.test(relativePath)) return false;
  return relativePath.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

export function isDocumentationPath(relativePath) {
  if (!isCanonicalGitPath(relativePath)) return false;
  if (!/\.(?:md|html)$/i.test(relativePath)) return false;
  if (relativePath.includes("/") && !relativePath.startsWith("docs/")) return false;
  return !consumedDocuments.has(relativePath);
}

export function classifyDocumentationChanges(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { docsOnly: false, reason: "no changed files were resolved" };
  }
  for (const entry of entries) {
    if (!/^[AM]$/.test(entry.status) || !isCanonicalGitPath(entry.path) ||
        entry.newMode !== "100644" ||
        (entry.status === "A" && entry.oldMode !== "000000") ||
        (entry.status === "M" && entry.oldMode !== "100644")) {
      return { docsOnly: false, reason: "change status, mode, or path requires full checks" };
    }
    if (!isDocumentationPath(entry.path)) {
      return { docsOnly: false, reason: `${entry.path} requires full checks` };
    }
  }
  return { docsOnly: true, reason: `${entries.length} documentation file(s) changed` };
}

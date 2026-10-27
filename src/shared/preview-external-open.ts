import { isComposerImageExtension } from "./composer-image-input.js";
import { previewDocumentFormatOf } from "./preview-document.js";
import { previewPageFormatOf } from "./preview-page-document.js";

const PASSIVE_TEXT_EXTENSIONS = Object.freeze([
  "txt", "md", "markdown", "json", "jsonc", "css", "scss", "sass", "less",
  "ts", "tsx", "c", "cc", "cpp", "h", "hpp", "cs", "go", "rs", "java",
  "kt", "sql", "yaml", "yml", "toml", "ini", "conf", "log", "diff", "patch",
]);

/** Preview reads admit passive formats; executable associations need picker authority. */
export function previewSupportsExternalOpen(path: string): boolean {
  if (previewDocumentFormatOf(path) || previewPageFormatOf(path)) return true;
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  return PASSIVE_TEXT_EXTENSIONS.includes(extension) || isComposerImageExtension(extension);
}

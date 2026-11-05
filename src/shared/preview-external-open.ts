import { isComposerImageExtension } from "./composer-image-input.js";
import { previewDocumentFormatOf } from "./preview-document.js";
import { previewPageFormatOf } from "./preview-page-document.js";

const PASSIVE_TEXT_EXTENSIONS = Object.freeze([
  "txt", "md", "markdown", "json", "jsonc", "css", "scss", "sass", "less",
  "ts", "tsx", "c", "cc", "cpp", "h", "hpp", "cs", "go", "rs", "java",
  "kt", "sql", "yaml", "yml", "toml", "ini", "conf", "log", "diff", "patch",
]);

/**
 * The only formats handed to the OS default app: documents, media, plain data and zip. Anything else (scripts, launchers,
 * shortcuts, installers, extensionless files, and svg/xml/html, whose browser handlers run scripts) is refused, because a
 * deny list of formats the OS will run never stays complete. Main enforces it on both the requested name and the target;
 * the renderer only uses it to hide an action that would be refused.
 */
const DEFAULT_APP_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key",
  "txt", "md", "csv", "tsv", "json", "yaml", "yml", "log",
  "mp3", "m4a", "wav", "flac", "aac", "ogg", "mp4", "mov", "m4v", "webm", "mkv", "avi",
  "zip",
  // The folder view's database info card opens these.
  "sqlite", "db",
]);

/** Lowercase extension of a path's last segment, or "" when it has none; the last extension decides. */
function defaultAppExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Whether "open in default app" is offered for this path's type at all. */
export function canOpenInDefaultApp(path: string): boolean {
  return DEFAULT_APP_EXTENSIONS.has(defaultAppExtension(path));
}

/** Preview reads admit passive formats; executable associations need picker authority. */
export function previewSupportsExternalOpen(path: string): boolean {
  if (!canOpenInDefaultApp(path)) return false;
  if (previewDocumentFormatOf(path) || previewPageFormatOf(path)) return true;
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  return PASSIVE_TEXT_EXTENSIONS.includes(extension) || isComposerImageExtension(extension);
}

/** Renderer and main share this picker deny-list; compare extensions in lowercase. */
export const DENY_EXTENSIONS = [
  "exe",
  "bat",
  "cmd",
  "com",
  "scr",
  "vbs",
  "msi",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "sh",
  "ps1",
] as const;

export type DenyExtension = (typeof DENY_EXTENSIONS)[number];

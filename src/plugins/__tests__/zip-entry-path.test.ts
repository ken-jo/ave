import { describe, expect, it } from "vitest";
import {
  canonicalZipEntryPathIdentity,
  sanitizeZipEntryPath,
} from "../zip-entry-path.js";

/** Artifacts must not contain data/, run/ or sockets/: promotion carries live state into those paths. */
describe("sanitizeZipEntryPath — reserved runtime directories", () => {
  it.each([
    "data/state.json",
    "data/",
    "data",
    "run/worker/control.sock",
    "sockets/egress.sock",
    // Case-folded runtime directory names also collide on macOS and Windows.
    "Data/state.json",
    "SOCKETS/egress.sock",
  ])("refuses %s", (entryName) => {
    expect(() => sanitizeZipEntryPath("sampleportal", entryName)).toThrow(
      /reserved plugin runtime directory name/,
    );
  });

  it("keeps the same names when they are nested inside the payload", () => {
    expect(sanitizeZipEntryPath("sampleportal", "dist/data/seed.json")).toBe("dist/data/seed.json");
    expect(sanitizeZipEntryPath("sampleportal", "database/schema.sql")).toBe("database/schema.sql");
  });
});

describe("sanitizeZipEntryPath", () => {
  it("preserves an unambiguous relative POSIX member name", () => {
    expect(sanitizeZipEntryPath("sampleportal", "skills/checkin/SKILL.md")).toBe(
      "skills/checkin/SKILL.md",
    );
    expect(sanitizeZipEntryPath("sampleportal", "skills/checkin/")).toBe("skills/checkin");
    expect(sanitizeZipEntryPath("sampleportal", "")).toBeNull();
  });

  it.each([
    "/absolute/file",
    "C:/drive/file",
    "dir\\file",
    "safe/../escape",
    "safe/./file",
    "safe//file",
    "../escape",
    ".",
  ])("rejects raw unsafe archive syntax: %s", (entryName) => {
    expect(() => sanitizeZipEntryPath("sampleportal", entryName)).toThrow(/zip entry/);
  });

  it.each([
    "plugin.json.",
    "skills/checkin ",
    "CON",
    "con.txt",
    "hooks/AUX.json",
    "NUL",
    "COM1",
    "mcp/LPT9.json",
    "COM¹.log",
    "file:stream",
    "bad<name",
    "bad>name",
    'bad"name',
    "bad|name",
    "bad?name",
    "bad*name",
  ])("rejects Windows-ambiguous or invalid archive segment: %s", (entryName) => {
    expect(() => sanitizeZipEntryPath("sampleportal", entryName)).toThrow(/zip entry/);
  });

  it("uses a Unicode-aware case-insensitive member identity", () => {
    expect(canonicalZipEntryPathIdentity("skills/Straße/SKILL.md")).toBe(
      canonicalZipEntryPathIdentity("SKILLS/STRASSE/skill.md"),
    );
  });
});

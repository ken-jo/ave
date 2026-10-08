/**
 * The files the web site publishes (web/public, design §11) parse with the
 * app's own parsers, so a site edit cannot ship a document the app refuses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarketplaceAnnouncementRows } from "../../../shared/marketplace-announcements.js";
import { AVE_SERVICE_BASE_URL, parseServiceDocument } from "../client.js";

const publicDir = join(__dirname, "..", "..", "..", "..", "web", "public");
const json = (path: string): unknown => JSON.parse(readFileSync(join(publicDir, path), "utf8"));

describe("published service files", () => {
  it("serves a service document naming the announcements file and no telemetry yet", () => {
    expect(parseServiceDocument(json(".well-known/former-service.json"), AVE_SERVICE_BASE_URL)).toEqual({
      announcements: `${AVE_SERVICE_BASE_URL}/announcements/v1.json`,
      telemetry: null,
      movedTo: null,
      movedFrom: null,
    });
  });

  it("serves an announcements file whose every row the app accepts", () => {
    const raw = json("announcements/v1.json") as { announcements: unknown[] };
    expect(Array.isArray(raw.announcements)).toBe(true);
    expect(parseMarketplaceAnnouncementRows(raw, "0.0.0")).toHaveLength(raw.announcements.length);
  });
});

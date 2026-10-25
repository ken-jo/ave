import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarketplaceAnnouncementRows } from "../../../shared/marketplace-announcements.js";
import { AVE_SERVICE_BASE_URL, parseServiceDocument } from "../client.js";
import { MCP_CLIENT_METADATA_DOCUMENT_URL } from "../../../mcp/mcp-oauth.js";

const publicDir = join(__dirname, "..", "..", "..", "..", "web", "public");
const json = (path: string): unknown => JSON.parse(readFileSync(join(publicDir, path), "utf8"));

describe("published service files", () => {
  it("serves a service document naming the announcements file and no telemetry yet", () => {
    expect(parseServiceDocument(json(".well-known/ave-service.json"), AVE_SERVICE_BASE_URL)).toEqual({
      announcements: `${AVE_SERVICE_BASE_URL}/announcements/v1.json`,
      telemetry: null,
      movedTo: null,
      movedFrom: null,
    });
  });

  it("serves the MCP client metadata document at the URL the app uses as its client_id", () => {
    expect(MCP_CLIENT_METADATA_DOCUMENT_URL).toBe(`${AVE_SERVICE_BASE_URL}/oauth/mcp-client.json`);
    expect(json("oauth/mcp-client.json")).toMatchObject({ client_id: MCP_CLIENT_METADATA_DOCUMENT_URL });
    expect(readFileSync(join(publicDir, "_headers"), "utf8")).toMatch(/\/oauth\/mcp-client\.json\n {2}Content-Type: application\/json/u);
  });

  it("serves an announcements file whose every row the app accepts", () => {
    const raw = json("announcements/v1.json") as { announcements: unknown[] };
    expect(Array.isArray(raw.announcements)).toBe(true);
    expect(parseMarketplaceAnnouncementRows(raw, "0.0.0")).toHaveLength(raw.announcements.length);
  });
});

import { describe, expect, it } from "vitest";
import type { Revocation } from "../../catalog/types.js";
import { revocationFeed } from "../revocations.js";

const revocation = (kind: Revocation["kind"], name: string, action: Revocation["action"] = "disable"): Revocation => ({
  kind,
  name,
  versions: "*",
  reason: `${name} is bad`,
  at: "2026-09-24T00:00:00Z",
  action,
});

describe("revocationFeed (design §10.4)", () => {
  it("gives each installed package only its own source's revocations of it", async () => {
    const lists: Record<string, Revocation[]> = {
      ave: [revocation("plugin", "meeting"), revocation("skill", "review"), revocation("plugin", "not-installed")],
      acme: [revocation("plugin", "meeting", "uninstall"), revocation("skill", "review", "uninstall")],
    };
    const asked: string[] = [];
    const feed = await revocationFeed(
      [
        { kind: "plugin", name: "meeting", sourceId: "ave" },
        { kind: "skill", name: "review", sourceId: "acme" },
      ],
      async (sourceId) => {
        asked.push(sourceId);
        return lists[sourceId] ?? [];
      },
    );
    expect(asked).toEqual(["ave", "acme"]);
    expect(feed.unreadable).toEqual([]);
    expect(feed.rules).toEqual([
      { ...revocation("plugin", "meeting"), sourceId: "ave" },
      { ...revocation("skill", "review", "uninstall"), sourceId: "acme" },
    ]);
  });

  it("reports a source whose snapshot cannot be read and keeps the others", async () => {
    const feed = await revocationFeed(
      [
        { kind: "plugin", name: "meeting", sourceId: "broken" },
        { kind: "plugin", name: "sampleportal", sourceId: "ave" },
      ],
      async (sourceId) => {
        if (sourceId === "broken") throw new Error("snapshot abc.json of broken names other@abc");
        return [revocation("plugin", "sampleportal")];
      },
    );
    expect(feed.unreadable).toEqual([{ sourceId: "broken", message: "snapshot abc.json of broken names other@abc" }]);
    expect(feed.rules).toEqual([{ ...revocation("plugin", "sampleportal"), sourceId: "ave" }]);
  });

  it("reads nothing when no install is bound to a source", async () => {
    const feed = await revocationFeed([], async () => {
      throw new Error("not asked");
    });
    expect(feed).toEqual({ rules: [], unreadable: [] });
  });
});

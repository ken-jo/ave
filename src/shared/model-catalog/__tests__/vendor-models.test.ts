import { afterEach, describe, expect, it } from "vitest";
import { activeModelCatalog, installModelCatalog } from "../active.js";
import { catalogChatModelIds } from "../vendor-models.js";
import type { CatalogModel } from "../types.js";

const original = activeModelCatalog();
const CHAT_MODEL: CatalogModel = {
  id: "current-model",
  limits: {},
  modalities: { input: ["text", "image"], output: ["text"] },
  toolCall: true,
  releaseDate: "2026-01-01",
};

afterEach(() => installModelCatalog(original));

describe("catalog model choices", () => {
  it("offers only usable chat entries in release order, with a stable id tie-break", () => {
    installModelCatalog({ ...original, providers: { openai: { models: {
      first: { ...CHAT_MODEL, id: "first", releaseDate: "2026-02-01" },
      second: { ...CHAT_MODEL, id: "second", releaseDate: "2026-02-01" },
      older: { ...CHAT_MODEL, id: "older" },
      retired: { ...CHAT_MODEL, id: "retired", status: "deprecated" },
      image: { ...CHAT_MODEL, id: "image", modalities: { input: ["text"], output: ["image"] } },
      "no-tools": { ...CHAT_MODEL, id: "no-tools", toolCall: false },
      unclassified: { id: "unclassified", limits: {} },
    } } } });
    expect(catalogChatModelIds("openai")).toEqual(["first", "second", "older"]);
    expect(Object.isFrozen(catalogChatModelIds("openai"))).toBe(true);
  });

  it("replaces cached choices when a new catalog is installed", () => {
    const before = { ...original, providers: { openai: { models: { "current-model": CHAT_MODEL } } } };
    installModelCatalog(before);
    expect(catalogChatModelIds("openai")).toEqual(["current-model"]);
    installModelCatalog({ ...before, providers: { openai: { models: {
      "current-model": CHAT_MODEL,
      "fresh-model": { ...CHAT_MODEL, id: "fresh-model", releaseDate: "2026-02-01" },
    } } } });
    expect(catalogChatModelIds("openai")).toEqual(["fresh-model", "current-model"]);
  });

  it("keeps the first mapped provider's deprecation authoritative across duplicates", () => {
    installModelCatalog({ ...original, providers: {
      "google-vertex": { models: { duplicate: { ...CHAT_MODEL, id: "duplicate", status: "deprecated" } } },
      "google-vertex-anthropic": { models: {
        duplicate: { ...CHAT_MODEL, id: "duplicate" },
        unique: { ...CHAT_MODEL, id: "unique" },
      } },
    } });
    expect(catalogChatModelIds("vertex-ai")).toEqual(["unique"]);
  });

  it("offers no public seed for an endpoint-defined route", () => {
    expect(catalogChatModelIds("openai-compatible")).toEqual([]);
  });
});

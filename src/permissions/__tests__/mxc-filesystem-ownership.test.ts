import { describe, expect, it } from "vitest";
import { assertMxcExtensionFilesystemOwnership, assertMxcHolderPrivateDirectories } from "../mxc-filesystem-ownership.js";

const PLUGINS = "C:\\private\\plugins";
const CACHE = `${PLUGINS}\\.cache`;
const GENERATION = `${CACHE}\\sample\\generation`;
const DATA = `${PLUGINS}\\sample\\data`;
const STORAGE = `${PLUGINS}\\sample\\storage`;
const OWNERSHIP = { readRoots: [GENERATION, DATA], writeRoots: [DATA], hostStorageRoots: [STORAGE] };
const BASE = { pluginNamespaceRoots: [PLUGINS, CACHE], ownership: OWNERSHIP };

describe("holder namespace ownership", () => {
  it("allows its captured generation/data while retaining ordinary runtime roots", () => {
    expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE,
      allowRead: [GENERATION, DATA, "C:\\runtime"], allowWrite: [`${DATA}\\records`] })).not.toThrow();
  });

  it.each([PLUGINS, CACHE, "C:\\private", "C:\\", `${PLUGINS}\\another\\data`])("rejects namespace or unrelated-holder grant %s", grant => {
    for (const field of ["allowRead", "allowWrite"] as const) {
      expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE, allowRead: [], allowWrite: [], [field]: [grant] })).toThrow(/another holder|outside this holder/);
    }
  });

  it.each([STORAGE, `${STORAGE}\\tokens`, `${PLUGINS}\\sample`])("rejects host storage or its ancestor %s for reads and writes", grant => {
    expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE, allowRead: [grant], allowWrite: [] })).toThrow(/host storage/);
    expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE, allowRead: [], allowWrite: [grant] })).toThrow(/host storage/);
  });

  it("does not accept requested grants as ownership and prevents generation writes", () => {
    expect(() => assertMxcExtensionFilesystemOwnership({ pluginNamespaceRoots: [PLUGINS], allowRead: [GENERATION], allowWrite: [] })).toThrow(/outside this holder/);
    expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE, allowRead: [], allowWrite: [GENERATION] })).toThrow(/outside this holder/);
  });

  it("refuses broad or host-storage-reaching ownership declarations", () => {
    for (const readRoot of [PLUGINS, CACHE, `${PLUGINS}\\sample`, STORAGE]) {
      expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE,
        ownership: { ...OWNERSHIP, readRoots: [readRoot] }, allowRead: [], allowWrite: [] })).toThrow(/ownership reaches/);
    }
  });

  it("compares namespace/storage paths without case sensitivity", () => {
    expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE, allowRead: [`${STORAGE.toUpperCase()}\\key`], allowWrite: [] })).toThrow(/host storage/);
  });
});

it("isolates private HOME/temp leaves using captured ownership rather than requested grants", () => {
  const homeRoot = "C:\\private\\sandbox-home";
  const tempRoot = "C:\\private\\sandbox-temp";
  const ownHome = `${homeRoot}\\holder-a`;
  const ownTemp = `${tempRoot}\\holder-a`;
  const captured = { pluginNamespaceRoots: [PLUGINS, homeRoot, tempRoot],
    ownership: { readRoots: [ownHome, ownTemp], writeRoots: [ownHome, ownTemp], hostStorageRoots: [] } };
  expect(() => assertMxcExtensionFilesystemOwnership({ ...captured, allowRead: [ownHome, ownTemp], allowWrite: [ownHome, ownTemp] })).not.toThrow();
  for (const other of [`${homeRoot}\\holder-b`, `${tempRoot}\\holder-b`, homeRoot, tempRoot]) {
    expect(() => assertMxcExtensionFilesystemOwnership({ ...captured, allowRead: [other], allowWrite: [] })).toThrow(/another holder|outside this holder/);
    expect(() => assertMxcExtensionFilesystemOwnership({ ...captured, allowRead: [], allowWrite: [other] })).toThrow(/another holder|outside this holder/);
  }
});

it("binds write grants outside plugin namespaces to the captured write roots too", () => {
  expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE, allowRead: [], allowWrite: ["D:\\work"] }))
    .toThrow(/outside this holder's captured write roots/);
  expect(() => assertMxcExtensionFilesystemOwnership({ ...BASE, ownership: { ...OWNERSHIP, writeRoots: [DATA, "D:\\work"] },
    allowRead: [], allowWrite: ["D:\\work\\out"] })).not.toThrow();
});

describe("holder HOME and temp placement", () => {
  const shared = ["C:\\private\\sandbox\\home", "C:\\private\\sandbox\\temp", "C:\\private\\sandbox\\handoff"];
  const staging = "C:\\private\\mxc-staging\\4f1c";
  const ownership = { readRoots: [], writeRoots: [staging], hostStorageRoots: [] };

  it("accepts a dedicated staging tree inside the captured write roots", () => {
    expect(() => assertMxcHolderPrivateDirectories({ home: `${staging}\\home`, temp: `${staging}\\temp`, ownership, sharedPrivateRoots: shared })).not.toThrow();
  });

  it("refuses HOME/temp outside the captured write roots", () => {
    expect(() => assertMxcHolderPrivateDirectories({ home: "D:\\elsewhere\\home", temp: `${staging}\\temp`, ownership, sharedPrivateRoots: shared }))
      .toThrow(/inside this holder's captured write roots/);
  });

  it.each(shared)("refuses HOME/temp below the shared private root %s even when captured as owned", root => {
    const leaf = `${root}\\holder-a`;
    const owned = { ...ownership, writeRoots: [leaf] };
    expect(() => assertMxcHolderPrivateDirectories({ home: leaf, temp: leaf, ownership: owned, sharedPrivateRoots: shared }))
      .toThrow(/dedicated staging tree/);
  });
});

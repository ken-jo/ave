// One policy model, two adapters. Every row of the table states a launch as policy rows and pins what each adapter makes of it:
// the sandbox runtime package lists and the ranked container grants. The expected values are literals, so a change in either
// adapter's output fails here.
import { describe, expect, it } from "vitest";
import { synthesizeMxcAncestorQueries } from "../mxc-filesystem-policy.js";
import { rankMxcFilesystem, type MxcFilesystemGrants } from "../mxc-windows.js";
import {
  buildPolicyModel, policyFloorRow as floor, policyGrantRow as grant,
  type PolicyFloorRow, type PolicyGrantRow, type PolicyModel, type PolicyModelInput,
} from "../policy-model.js";
import { toSrtConfig, type SrtFilesystemLists } from "../srt-policy-adapter.js";

const HOME = "C:\\Users\\alice";
const WORK = `${HOME}\\work`;
const DATA = "C:\\plugins\\data";

const model = (input: Partial<PolicyModelInput>): PolicyModel =>
  buildPolicyModel({ floors: [], userGrants: [], extensionManifests: [], launchGrants: [], ...input });

interface AdapterRow {
  readonly name: string;
  readonly model: PolicyModel;
  /** Which paths exist when the container adapter ranks the rows. */
  readonly exists: (path: string) => boolean;
  /** `undefined` when the package lists cannot carry the rows. */
  readonly srt: SrtFilesystemLists | undefined;
  readonly mxc: MxcFilesystemGrants;
}

const everything = (): boolean => true;

const TABLE: readonly AdapterRow[] = [
  {
    // A secret inside a write grant is denied there. The container adapter withholds a grant beneath the floor; the package's
    // composers withhold such a grant before they state their rows, so the package lists replay the rows as given.
    name: "secrets",
    model: model({
      floors: [floor(`${HOME}\\.ssh`, "denied", "secrets"), floor(`${WORK}\\.env`, "denied", "secrets")],
      userGrants: [
        grant(WORK, "rw", "user-grant"),
        grant(`${HOME}\\.ssh\\config`, "ro", "user-grant"),
        grant("C:\\tools", "ro", "user-grant"),
      ],
    }),
    exists: everything,
    srt: {
      allowRead: [`${HOME}\\.ssh\\config`, "C:\\tools"], allowWrite: [WORK],
      denyRead: [`${HOME}\\.ssh`, `${WORK}\\.env`], denyWrite: [],
    },
    mxc: { readwrite: [WORK], readonly: ["C:\\tools"], denied: [`${WORK}\\.env`] },
  },
  {
    // A present protected name becomes read-only, an absent one is denied so it cannot be created, one outside every grant needs
    // no container row. A literal row keeps its marker in the package list.
    name: "protected names",
    model: model({
      floors: [
        floor(`${WORK}\\.git\\hooks`, "ro", "protected-name"),
        floor(`${WORK}\\.vscode`, "ro", "protected-name"),
        floor(`${HOME}\\.bashrc`, "ro", "protected-name"),
        floor(`${WORK}\\.envrc`, "ro", "protected-name", true),
      ],
      userGrants: [grant(WORK, "rw", "user-grant")],
    }),
    exists: (path) => path !== `${WORK}\\.vscode`,
    srt: {
      allowRead: [], allowWrite: [WORK], denyRead: [],
      denyWrite: [`${WORK}\\.git\\hooks`, `${WORK}\\.vscode`, `${HOME}\\.bashrc`, { path: `${WORK}\\.envrc`, literal: true }],
    },
    mxc: { readwrite: [WORK], readonly: [`${WORK}\\.git\\hooks`, `${WORK}\\.envrc`], denied: [`${WORK}\\.vscode`] },
  },
  {
    // An extension worker holds its own data and generation roots. The shared storage root above them is a read boundary: it
    // needs no container row, and a boundary inside the worker's own root stays denied.
    name: "worker grants",
    model: model({
      floors: [
        floor(DATA, "denied", "read-boundary"),
        floor(`${DATA}\\p1\\private`, "denied", "read-boundary"),
        floor(`${DATA}\\p1\\.envrc`, "ro", "protected-name"),
      ],
      extensionManifests: [
        grant(`${DATA}\\p1`, "rw", "extension-manifest"),
        grant("C:\\plugins\\gen\\p1", "ro", "extension-manifest"),
      ],
    }),
    exists: everything,
    srt: {
      allowRead: ["C:\\plugins\\gen\\p1"], allowWrite: [`${DATA}\\p1`],
      denyRead: [DATA, `${DATA}\\p1\\private`], denyWrite: [`${DATA}\\p1\\.envrc`],
    },
    mxc: { readwrite: [`${DATA}\\p1`], readonly: ["C:\\plugins\\gen\\p1", `${DATA}\\p1\\.envrc`], denied: [`${DATA}\\p1\\private`] },
  },
  {
    // The Ave home is denied whole under a broad read grant, and a re-allowed child stays readable beneath it.
    name: "the Ave home floor",
    model: model({
      floors: [floor(`${HOME}\\.ave`, "denied", "ave-home"), floor(`${HOME}\\.ave\\secrets`, "denied", "secrets")],
      launchGrants: [
        grant(WORK, "rw", "launch-grant"),
        grant(HOME, "ro", "launch-grant"),
        grant(`${HOME}\\.ave\\skills`, "ro", "launch-grant"),
      ],
    }),
    exists: everything,
    srt: {
      allowRead: [HOME, `${HOME}\\.ave\\skills`], allowWrite: [WORK],
      denyRead: [`${HOME}\\.ave`, `${HOME}\\.ave\\secrets`], denyWrite: [],
    },
    mxc: { readwrite: [WORK], readonly: [HOME, `${HOME}\\.ave\\skills`], denied: [`${HOME}\\.ave`] },
  },
  {
    // An absent grant is not handed to the container, and a write grant the write floor names is granted read-only.
    name: "user grants",
    model: model({
      floors: [floor(`${HOME}\\notes`, "ro", "protected-name")],
      userGrants: [
        grant(WORK, "rw", "user-grant"),
        grant(`${HOME}\\missing`, "rw", "user-grant"),
        grant(`${HOME}\\notes`, "rw", "user-grant"),
        grant("C:\\ref", "ro", "user-grant"),
      ],
    }),
    exists: (path) => path !== `${HOME}\\missing`,
    srt: {
      allowRead: ["C:\\ref"], allowWrite: [WORK, `${HOME}\\missing`, `${HOME}\\notes`],
      denyRead: [], denyWrite: [`${HOME}\\notes`],
    },
    mxc: { readwrite: [WORK], readonly: ["C:\\ref", `${HOME}\\notes`], denied: [] },
  },
  {
    // Neither adapter refuses a volume root; the container request builder does (see the test below).
    name: "volume-root",
    model: model({
      floors: [floor(`${HOME}\\.ave`, "denied", "ave-home")],
      userGrants: [grant("C:\\", "rw", "user-grant")],
    }),
    exists: everything,
    srt: { allowRead: [], allowWrite: ["C:\\"], denyRead: [`${HOME}\\.ave`], denyWrite: [] },
    mxc: { readwrite: ["C:\\"], readonly: [], denied: [`${HOME}\\.ave`] },
  },
  {
    // A pierce keeps the one grant it covers under the secrets floor and stops that floor row from denying it. The package lists
    // have no place for a pierce.
    name: "floor pierce",
    model: model({
      floors: [floor(`${HOME}\\.ave\\sessions`, "denied", "secrets"), floor(`${HOME}\\.ave\\keys`, "denied", "secrets")],
      launchGrants: [
        grant(HOME, "ro", "launch-grant"),
        grant(`${HOME}\\.ave\\sessions`, "ro", "launch-grant"),
        grant(`${HOME}\\.ave\\keys`, "ro", "launch-grant"),
        grant(`${HOME}\\.ave\\sessions`, "ro", "floor-pierce"),
      ],
    }),
    exists: everything,
    srt: undefined,
    mxc: { readwrite: [], readonly: [HOME, `${HOME}\\.ave\\sessions`], denied: [`${HOME}\\.ave\\keys`] },
  },
];

describe("policy model adapters", () => {
  it.each(TABLE)("projects $name onto the sandbox runtime package lists", (row) => {
    if (row.srt === undefined) expect(() => toSrtConfig(row.model)).toThrow(/cannot carry a floor pierce/);
    else expect(toSrtConfig(row.model)).toEqual(row.srt);
  });

  it.each(TABLE)("ranks $name into container grants", (row) => {
    expect(rankMxcFilesystem(row.model, row.exists)).toEqual(row.mxc);
  });

  it("leaves the volume-root refusal to the container request builder", () => {
    const grants = TABLE.filter((row) => row.name === "volume-root").map((row) => row.mxc);
    expect(grants).toHaveLength(1);
    for (const ranked of grants) expect(() => synthesizeMxcAncestorQueries(ranked)).toThrow(/refuses volume-root content grants/);
  });

  it("keeps the order rows were stated in, inside each input and across inputs", () => {
    const built = buildPolicyModel({
      floors: [floor("C:\\b", "denied", "read-boundary"), floor("C:\\a", "denied", "ave-home")],
      userGrants: [grant("C:\\u", "rw", "user-grant")],
      extensionManifests: [grant("C:\\e", "rw", "extension-manifest")],
      launchGrants: [grant("C:\\l", "rw", "launch-grant")],
    });
    expect(built.rows.map((row) => row.path)).toEqual(["C:\\b", "C:\\a", "C:\\u", "C:\\e", "C:\\l"]);
    expect(toSrtConfig(built)).toMatchObject({ denyRead: ["C:\\b", "C:\\a"], allowWrite: ["C:\\u", "C:\\e", "C:\\l"] });
    expect(Object.isFrozen(built.rows) && built.rows.every((row) => Object.isFrozen(row))).toBe(true);
  });

  it("refuses the package projection of a literal row outside the write floor", () => {
    expect(() => toSrtConfig(model({ userGrants: [grant(WORK, "rw", "user-grant", true)] }))).toThrow(/literal rows only on the write floor/);
  });

  it.each<[string, Partial<PolicyModelInput>]>([
    ["a floor row that gives access", { floors: [{ ...floor(WORK, "denied", "secrets"), access: "rw" } as unknown as PolicyFloorRow] }],
    ["a readable secrets row", { floors: [floor(WORK, "ro", "secrets")] }],
    ["a denied protected name", { floors: [floor(WORK, "denied", "protected-name")] }],
    ["a grant reason among the floors", { floors: [grant(WORK, "ro", "user-grant") as unknown as PolicyFloorRow] }],
    ["a grant under the wrong input", { extensionManifests: [grant(WORK, "rw", "user-grant")] }],
    ["a grant that denies", { userGrants: [{ ...grant(WORK, "ro", "user-grant"), access: "denied" } as unknown as PolicyGrantRow] }],
    ["a writable floor pierce", { launchGrants: [grant(WORK, "rw", "floor-pierce")] }],
    ["a row without a path", { userGrants: [{ literal: false, access: "rw", reason: "user-grant" } as unknown as PolicyGrantRow] }],
  ])("refuses %s", (_name, input) => {
    expect(() => model(input)).toThrow(/^Policy model row is invalid/);
  });
});

/** Wire params must match actual member parameter names, including nested interfaces and overloads. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast";
import { HOSTAPI_PATH_CONTRACTS, type HostApiPath } from "../host-api-wire.js";

const PUBLIC_CONTRACT = fileURLToPath(new URL("../../public-contract.ts", import.meta.url));

interface NamedNode extends Node {
  readonly name?: { readonly text?: string };
}
interface MemberNode extends NamedNode {
  readonly parameters?: readonly NamedNode[];
  readonly type?: Node;
}
interface ContainerNode extends NamedNode {
  readonly members?: readonly MemberNode[];
  readonly type?: Node;
  readonly typeName?: { readonly text?: string };
}

/** Enumerate each member signature; overloads with incompatible param names cannot share one wire shape. */
function declaredParameterNames(sourceFile: SourceFile): Map<string, readonly string[]> {
  const declarations = new Map<string, ContainerNode>();
  for (const statement of sourceFile.statements as readonly ContainerNode[]) {
    if (
      (statement.kind === SyntaxKind.InterfaceDeclaration
        || statement.kind === SyntaxKind.TypeAliasDeclaration)
      && statement.name?.text
    ) {
      declarations.set(statement.name.text, statement);
    }
  }

  const membersOf = (node: ContainerNode | undefined): readonly MemberNode[] => {
    if (!node) return [];
    if (node.kind === SyntaxKind.InterfaceDeclaration || node.kind === SyntaxKind.TypeLiteral) {
      return node.members ?? [];
    }
    if (node.kind === SyntaxKind.TypeAliasDeclaration) return membersOf(node.type as ContainerNode);
    if (node.kind === SyntaxKind.TypeReference && node.typeName?.text) {
      return membersOf(declarations.get(node.typeName.text));
    }
    return [];
  };

  const found = new Map<string, readonly string[]>();
  const walk = (container: ContainerNode | undefined, prefix: string): void => {
    const signatures = new Map<string, Array<readonly string[]>>();
    for (const member of membersOf(container)) {
      const name = member.name?.text;
      if (!name) continue;
      if (member.kind === SyntaxKind.MethodSignature) {
        const names = (member.parameters ?? []).map((parameter) => parameter.name?.text ?? "");
        signatures.set(name, [...(signatures.get(name) ?? []), names]);
      } else if (member.kind === SyntaxKind.PropertySignature) {
        walk(member.type as ContainerNode, `${prefix}${name}.`);
      }
    }
    for (const [name, overloads] of signatures) {
      const [first, ...rest] = overloads;
      for (const other of rest) {
        if (JSON.stringify(other) !== JSON.stringify(first)) {
          throw new Error(`overloads of '${prefix}${name}' name their parameters differently`);
        }
      }
      found.set(`${prefix}${name}`, first!);
    }
  };
  walk(declarations.get("PluginHostApi"), "");
  return found;
}

let workDir: string;
let declared: Map<string, readonly string[]>;

beforeAll(() => {
  // Read syntax in a one-file project without resolving imports or loading libraries.
  workDir = mkdtempSync(join(tmpdir(), "host-api-path-params-"));
  const tsconfig = join(workDir, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: { noResolve: true, noLib: true, types: [] },
      files: [PUBLIC_CONTRACT],
    }),
  );
  const api = new API({ cwd: workDir });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [tsconfig] });
    const sourceFile = snapshot.getProjects()[0]?.program.getSourceFile(PUBLIC_CONTRACT);
    if (!sourceFile) throw new Error(`the compiler did not load ${PUBLIC_CONTRACT}`);
    declared = declaredParameterNames(sourceFile);
  } finally {
    api.close();
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("the params axis", () => {
  it("names every path's parameters exactly as PluginHostApi declares them, in order", () => {
    for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]) {
      expect(declared.has(path), `'${path}' is not a member of PluginHostApi`).toBe(true);
      expect(HOSTAPI_PATH_CONTRACTS[path].params, path).toEqual(declared.get(path));
    }
  });

  it("reads through a named interface, an inline object type and an overload set", () => {
    // Positive controls cover every nested-member syntax so omissions cannot pass vacuously.
    expect(declared.get("storage.write")).toEqual(["relPath", "data", "encoding"]);
    expect(declared.get("authRedirect.wait")).toEqual(["options"]);
    expect(declared.get("openAuthWindow")).toEqual(["options"]);
  });
});

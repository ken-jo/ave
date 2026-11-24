import type { Identifier, Node, SourceFile } from "typescript/unstable/ast";

/** A parsed source file, as far as typed callers read it. */
export interface ParsedSourceFile {
  readonly text: string;
}

export function parseSourceFiles(paths: readonly string[]): Map<string, ParsedSourceFile>;

export function parseSourceTexts(texts: ReadonlyMap<string, string>): Map<string, ParsedSourceFile>;

export function withParsedSourceTexts<T>(
  texts: ReadonlyMap<string, string>,
  inspect: (
    sources: Map<string, SourceFile>,
    resolveDeclarations: (file: string, identifiers: Identifier[], options?: { shorthandValues?: boolean }) => Map<Identifier, Node | undefined>,
  ) => T,
): T;

export function assertAllowedDocumentRead(input: string | Buffer | URL, root?: string): void;
export function assertPackagedDocumentInputs(packageJson: unknown, root?: string): void;
export function assertBundledDocumentInputs(paths: Iterable<string>, root?: string): void;
export class DocumentDependencyPlugin {
  apply(compiler: unknown): void;
}

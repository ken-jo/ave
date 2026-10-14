export function isCanonicalGitPath(relativePath: string): boolean;
export function isDocumentationPath(relativePath: string): boolean;
export function getRecordedDocumentReaders(relativePath: string): readonly string[] | null;
export function classifyDocumentationChanges(
  entries: { status: string; path: string; oldMode: string; newMode: string }[],
): { docsOnly: boolean; reason: string };

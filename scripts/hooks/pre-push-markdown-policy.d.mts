export function isCanonicalGitPath(relativePath: string): boolean;
export function isDocumentationPath(relativePath: string): boolean;
export function classifyDocumentationChanges(
  entries: { status: string; path: string }[],
): { docsOnly: boolean; reason: string };

export interface Anchor {
  href: string;
  cls: string[];
  hreflang?: string;
  label: string;
}

export function finishNotFound(outDir: string): void;
export function anchors(html: string): Anchor[];
export function analyzePages(
  pages: Map<string, string>,
  exists: (urlPath: string) => boolean,
  options?: { notFound?: string[]; origin?: string },
): string[];
export function checkExport(outDir: string, options: { origin: string }): string[];

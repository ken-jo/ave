export const PUBLISHED_SCHEMAS: ReadonlyArray<Readonly<{ source: string; path: string; id: string }>>;
export function checkPublishedSchemas(root: string): string;
export function syncPublishedSchemas(root: string): void;

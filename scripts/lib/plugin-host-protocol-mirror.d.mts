export function hostProtocolSchemaId(relative: string): string;
export const PUBLISHED_SCHEMAS: ReadonlyArray<Readonly<{ source: string; path: string; id: string }>>;
export function checkPublishedSchemas(root: string): string;
export function syncPublishedSchemas(root: string): void;
export function checkProtocolMirror(root: string): string;
export function syncProtocolMirror(root: string, generatedFrom: string): void;
export function publishProtocolMirror(root: string, target: string): string;

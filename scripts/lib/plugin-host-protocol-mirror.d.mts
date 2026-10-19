export function hostProtocolSchemaId(relative: string): string;
export const PUBLISHED_SCHEMAS: ReadonlyArray<Readonly<{ source: string; path: string; id: string }>>;
export function checkPublishedSchemas(root: string): string;
export function syncPublishedSchemas(root: string): void;
/** The canonical schema bytes tag `v<appVersion>` carries, `null` when no such tag exists. */
export type TaggedSchemaReader = (root: string, appVersion: string, protocol: string) => Buffer | null;
export interface TaggedSchemaOptions { taggedSchema?: TaggedSchemaReader }
export function checkProtocolMirror(root: string, options?: TaggedSchemaOptions): string;
export function syncProtocolMirror(root: string, generatedFrom: string, options?: TaggedSchemaOptions): void;
export function publishProtocolMirror(root: string, target: string, options?: TaggedSchemaOptions): string;

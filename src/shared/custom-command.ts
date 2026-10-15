/** Where a custom slash command file lives; the project directory wins a name clash. */
export type CustomCommandScope = "project" | "user";

/** A custom slash command as the picker lists it (the body stays in main). */
export interface CustomCommandEntry {
  /** The command is typed as `/<name>`. */
  name: string;
  scope: CustomCommandScope;
  /** Frontmatter `description`; empty when the file has none. */
  description: string;
  /** Frontmatter `argument-hint`. */
  argumentHint?: string;
}

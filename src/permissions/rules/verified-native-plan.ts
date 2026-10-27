export interface VerifiedNativePlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly prepareEnvironment?: (base: Readonly<Record<string, string>>) => Record<string, string>;
  readonly available?: () => boolean;
  readonly proof:
    | { readonly kind: "literal-evaluation"; readonly payloadIndexes: readonly number[]; readonly changesState: false }
    | { readonly kind: "static-complete"; readonly changesState: false };
}

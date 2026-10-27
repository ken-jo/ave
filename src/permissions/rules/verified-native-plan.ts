export interface VerifiedNativePlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly available?: () => boolean;
  readonly environment: Readonly<Record<string, string>>;
  readonly prepareEnvironment?: (base: Readonly<Record<string, string>>) => Record<string, string>;
  readonly proof: { readonly kind: "static-complete"; readonly changesState: false }
    | { readonly kind: "literal-evaluation"; readonly payloadIndexes: readonly number[]; readonly changesState: false };
}

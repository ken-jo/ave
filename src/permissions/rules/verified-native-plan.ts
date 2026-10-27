export interface VerifiedNativePlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly proof: { readonly kind: "literal-evaluation"; readonly payloadIndexes: readonly number[]; readonly changesState: false };
}

export type UnboundedInputExemption = {
  readonly listing?: string;
  readonly git?: string;
  readonly read?: string;
  readonly forwards?: { readonly listing?: readonly string[]; readonly read?: readonly string[] };
};
export type UnboundedInputExemptions = Readonly<Record<string, UnboundedInputExemption>>;
export const UNBOUNDED_INPUT_EXEMPTIONS: UnboundedInputExemptions;

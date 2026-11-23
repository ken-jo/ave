export type UnboundedInputExemption = {
  readonly listing?: string;
  readonly git?: string;
  readonly read?: string;
  readonly forwards?: { readonly listing?: readonly string[]; readonly read?: readonly string[] };
};
export type UnboundedInputExemptions = Readonly<Record<string, UnboundedInputExemption>>;
export const UNBOUNDED_INPUT_EXEMPTIONS: UnboundedInputExemptions;
export type UnboundedInputTempHelper = {
  readonly digest: string;
  readonly covers?: readonly string[];
  readonly factories: Readonly<Record<string, "directory" | "path">>;
  readonly reason: string;
};
export const UNBOUNDED_INPUT_TEMP_HELPERS: Readonly<Record<string, UnboundedInputTempHelper>>;

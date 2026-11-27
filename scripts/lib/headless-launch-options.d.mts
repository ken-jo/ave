export const HEADLESS_FORBIDDEN_INHERITED_ENV: readonly string[];
export function prepareHeadlessLaunchEnv<T extends Record<string, string | undefined>>(env: T): T;
export function headlessLaunchArgs(args: readonly string[]): string[] | null;

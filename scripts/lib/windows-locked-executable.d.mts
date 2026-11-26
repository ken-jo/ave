export function lockWindowsExecutable(executable: string): { path: string; bytes: Buffer; close(): void };
export function withVerifiedWindowsExecutable<T>(executable: string, expectedSha256: string, launch: (path: string) => T): T;

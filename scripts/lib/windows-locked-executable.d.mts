export class WindowsExecutableError extends Error {
  constructor(message: string, code?: string);
  readonly code?: string;
}

export function lockWindowsExecutable(executable: string): { path: string; bytes: Buffer; close(): void };
export function lockWindowsExecutableAsync(executable: string, checkDeadline: () => void): Promise<ReturnType<typeof lockWindowsExecutable>>;
export function withVerifiedWindowsExecutable<T>(executable: string, expectedSha256: string, launch: (path: string) => T): T;

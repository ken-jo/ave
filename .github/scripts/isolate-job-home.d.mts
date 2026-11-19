export function isolationAssignments(options: {
  platform: NodeJS.Platform;
  runnerTemp: string;
  systemRoot?: string;
}, create?: (prefix: string) => string): Record<string, string>;

export function validateJobHomeRoot(root: string, systemRoot: string): string;

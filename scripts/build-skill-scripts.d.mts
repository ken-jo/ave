export function buildSkillScripts(options?: { pathKindSha256?: string | null; directory?: string }): Promise<{ directory: string; scripts: Record<string, string> }>;

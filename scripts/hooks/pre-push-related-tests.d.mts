export interface RelatedTestCoverage {
  source: string;
  tests: string[];
}
export function collectRelatedTestFiles(context: {
  config: { related?: string[] };
  getRelevantTestSpecifications(): Promise<{ moduleId: string }[]>;
}, sourceFiles: string[], repoRoot: string): Promise<RelatedTestCoverage[]>;

type CollectedSpec = {
  id: string;
  file: string;
  title: string;
  tests: Array<{ projectName: string }>;
};

type CollectedSuite = {
  title: string;
  specs?: CollectedSpec[];
  suites?: CollectedSuite[];
};

type BackgroundCollection = {
  config: {
    fullyParallel: boolean;
    workers: number;
    shard?: { current: number; total: number } | null;
    projects: Array<{ name: string; retries: number }>;
  };
  errors?: unknown[];
  suites: CollectedSuite[];
};

type BackgroundShardPlan = {
  matrix: { include: Array<{ id: number; regularShard: number; testList: string }> };
  lists: Record<string, string>;
  manifest: {
    project: string;
    regularShards: number;
    totalPartitions: number;
    selectedTests: number;
    collectionFile: string;
    regularTestIds: string[];
    specialPartitions: Array<{ id: number; file: string; testList: string; testIds: string[] }>;
  };
};

export function planBackgroundShards(collection: BackgroundCollection): BackgroundShardPlan;
export function writeBackgroundShardPlan(collectionPath: string, outputDirectory: string, githubOutput?: string): BackgroundShardPlan;

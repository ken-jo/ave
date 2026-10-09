import type { RepositoryIdentity } from "./lib/repository-identity.mjs";

export declare function assertReleaseRepository(input: {
  identity: RepositoryIdentity;
  repository: string | undefined;
}): string;

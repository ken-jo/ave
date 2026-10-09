export interface RepositoryIdentity {
  readonly owner: string;
  readonly repo: string;
  /** `owner/repo`, the form `github.repository` and `$GITHUB_REPOSITORY` use. */
  readonly slug: string;
}

export declare function repositoryIdentity(packageJson: unknown): RepositoryIdentity;

export declare function readRepositoryIdentity(root?: string): RepositoryIdentity;

/** Host-owned authority captured from the exact pending approval. */
export interface ApprovalPersistenceGuard {
  refresh(): Promise<boolean>;
  isCurrent(): boolean;
}

export async function refreshApprovalPersistence(guard: ApprovalPersistenceGuard | undefined): Promise<void> {
  if (guard && (!await guard.refresh() || !guard.isCurrent())) throw new Error("Approval authority is unavailable");
}

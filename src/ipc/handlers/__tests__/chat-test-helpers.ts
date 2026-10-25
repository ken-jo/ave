export function turnOptions(runTurn: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const call = runTurn.mock.calls[0] as unknown[];
  return call[3] as Record<string, unknown>;
}

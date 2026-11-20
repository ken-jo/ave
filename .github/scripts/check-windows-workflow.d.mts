export function windowsRegressionFiles(workflow: string, inventories: ReadonlyMap<string, string>): string[];
export function windowsRegressionStepFiles(run: string, readInventory: (path: string) => string | undefined, name: string): string[];

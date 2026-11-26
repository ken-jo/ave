import { isAbsolute } from "node:path";

export interface HostResources {
  readonly resourcePath: string;
  readonly isPackaged: boolean;
}

let resources: HostResources | undefined;

// The composition root supplies resource locations before starting services.
export function configureHostResources(input: HostResources): void {
  if (!isAbsolute(input.resourcePath)) throw new Error("host-resources-path-must-be-absolute");
  resources = Object.freeze({ resourcePath: input.resourcePath, isPackaged: input.isPackaged });
}

// A child process or worker has no composition root; it adopts its parent's resources or refuses to run.
export function adoptHostResources(handoff: unknown): void {
  const value = handoff as Partial<HostResources> | null;
  if (value === null || typeof value !== "object" || typeof value.resourcePath !== "string" || typeof value.isPackaged !== "boolean") {
    throw new Error("host-resources-unavailable");
  }
  configureHostResources({ resourcePath: value.resourcePath, isPackaged: value.isPackaged });
}

export function getHostResources(): HostResources {
  if (!resources) throw new Error("host-resources-unavailable");
  return resources;
}

// Source-tree document utilities may run before a host is composed.
export function getConfiguredHostResources(): HostResources | undefined {
  return resources;
}

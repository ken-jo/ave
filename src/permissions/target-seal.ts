import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { fileIdentityKey, type FileIdentity } from "../lib/file-identity.js";
import { admitLocalPath, admitLocalRoute, isLocalityFailure, localFs, withLocalityDecision } from "../shared/local-path-io.js";
import { tryNativeRealpath } from "../shared/shell-filesystem-path.js";

/**
 * What a judgment observed about its original operands, carried to each effect the judgment authorizes. `verify` observes
 * the same operands again and refuses any difference; it never adopts the new answer. An effect checks its seals
 * synchronously with the effect itself, after its last wait.
 */
export interface TargetSeal {
  verify(): void;
  /** Runtime spelling of a file operand captured with its authorization. */
  pathFor?(path: string): string | undefined;
  /** Check a descriptor against the identity judged for this physical read path. */
  assertOpenedRead?(path: string, identity: FileIdentity): void;
  /** Physical parent with the original name retained for a by-name mutation. */
  entryFor?(path: string): string | undefined;
  /** Keep checking the route after an authorized operation has changed this entry. */
  afterMutation?(path: string): TargetSeal;
}

export class TargetIdentityChangedError extends Error {
  constructor() {
    super("Target identity changed");
  }
}

export function fileTargetSealFailureKey(error: unknown) {
  const unverified = process.platform === "win32" && (isLocalityFailure(error) ||
    (error instanceof Error && "code" in error && error.code === "ENETWORKSHAREPATH"));
  return unverified ? "be_executor.fileTargetUnverified" : "be_executor.fileTargetChanged";
}

export interface WindowsTargetObservation {
  path: string;
  ancestor: string;
  identity: string;
}

function identityAt(path: string): string {
  const stats = localFs.lstatBigint(admitLocalPath(path));
  if (stats === undefined || stats.isSymbolicLink()) throw new TargetIdentityChangedError();
  return fileIdentityKey(stats);
}

export function observeWindowsTarget(path: string, rejectDanglingLink = false): WindowsTargetObservation {
  return withLocalityDecision(() => {
    const route = admitLocalRoute(resolve(path), { projectMissing: true, rejectDanglingLink });
    if (route.physical === undefined || route.existingAncestor === undefined) throw new TargetIdentityChangedError();
    return { path: route.physical, ancestor: route.existingAncestor, identity: identityAt(route.existingAncestor) };
  });
}

export function assertWindowsTarget(expected: WindowsTargetObservation, actual: WindowsTargetObservation, allowCreatedDirectory = false): void {
  if (actual.path !== expected.path) throw new TargetIdentityChangedError();
  if (actual.ancestor === expected.ancestor) {
    if (actual.identity !== expected.identity) throw new TargetIdentityChangedError();
    return;
  }
  // Some effects create missing parent directories. Keep the originally admitted ancestor pinned.
  if (expected.ancestor === expected.path || (!allowCreatedDirectory && actual.ancestor === actual.path) ||
      identityAt(expected.ancestor) !== expected.identity) {
    throw new TargetIdentityChangedError();
  }
}

// Darwin's fcntl.h flag rejects symlinks in every component. Node exposes only the last-component flag.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function holdPosixReadRoute(path: string): { path: string; flags: number; release(): void } {
  if (process.platform === "darwin") {
    return { path, flags: constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_O_NOFOLLOW_ANY, release() {} };
  }
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || !path.startsWith("/")) {
    throw new TargetIdentityChangedError();
  }
  const components = path.split("/").filter(Boolean);
  const leaf = components.pop() ?? ".";
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let directory = openSync("/", directoryFlags);
  try {
    for (const component of components) {
      const next = openSync(`/proc/self/fd/${directory}/${component}`, directoryFlags);
      closeSync(directory);
      directory = next;
    }
    return { path: `/proc/self/fd/${directory}/${leaf}`, flags: READ_FLAGS, release: () => closeSync(directory) };
  } catch (error) {
    closeSync(directory);
    throw error;
  }
}

function observePosixReadTarget(operand: string): { path: string; identity: string } {
  const path = tryNativeRealpath(operand);
  if (path === undefined) throw new TargetIdentityChangedError();
  const route = holdPosixReadRoute(path);
  try {
    const fd = openSync(route.path, route.flags);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if ((!opened.isFile() && !opened.isDirectory()) || tryNativeRealpath(operand) !== path ||
          identityAt(path) !== fileIdentityKey(opened)) throw new TargetIdentityChangedError();
      return { path, identity: fileIdentityKey(opened) };
    } finally {
      closeSync(fd);
    }
  } finally {
    route.release();
  }
}

export function sealReadTargets(operands: readonly string[]): TargetSeal {
  const { observation, seal } = sealTargetObservation(
    () => operands.map((operand) => {
      if (process.platform !== "win32") return { operand, ...observePosixReadTarget(operand) };
      const { path, ancestor, identity } = observeWindowsTarget(operand);
      if (path !== ancestor) throw new TargetIdentityChangedError();
      return { operand, path, identity };
    }),
    (targets) => JSON.stringify(targets),
  );
  const paths = new Map(observation.map(({ operand, path }) => [operand, path]));
  const identities = new Map(observation.map(({ path, identity }) => [path, identity]));
  return {
    ...seal,
    pathFor: (path) => paths.get(path),
    assertOpenedRead: (path, identity) => {
      if (identities.get(path) !== fileIdentityKey(identity)) throw new TargetIdentityChangedError();
    },
  };
}

export async function openSealedReadTarget(path: string, seal?: TargetSeal): Promise<FileHandle> {
  if (!seal?.assertOpenedRead) return open(path, READ_FLAGS);
  seal.verify();
  const route = process.platform === "win32" ? { path, flags: READ_FLAGS, release() {} } : holdPosixReadRoute(path);
  try {
    const handle = await open(route.path, route.flags);
    try {
      seal.assertOpenedRead(path, await handle.stat({ bigint: true }));
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  } finally {
    route.release();
  }
}

/** Seal what `observe` reports now. Inside a running decision the seal shares that decision's observations. */
export function sealTargets(observe: () => string): TargetSeal {
  return sealTargetObservation(observe, (identity) => identity).seal;
}

export function sealTargetObservation<T>(observe: () => T, identity: (observation: T) => string): { observation: T; seal: TargetSeal } {
  const observation = withLocalityDecision(observe);
  const expected = identity(observation);
  return {
    observation,
    seal: {
      verify: () => {
        if (identity(withLocalityDecision(observe)) !== expected) throw new TargetIdentityChangedError();
      },
    },
  };
}

/** Whether every seal still holds, observed in one decision. A failed observation does not hold. */
export function sealsHold(...seals: ReadonlyArray<TargetSeal | undefined>): boolean {
  try {
    withLocalityDecision(() => { for (const seal of seals) seal?.verify(); });
    return true;
  } catch {
    return false;
  }
}

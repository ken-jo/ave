import { win32 as winPath } from "node:path";

function normalizeDirectory(directory) {
  const normalized = winPath.normalize(directory);
  if (!/^[a-z]:\\/i.test(normalized)) throw new Error("Probe grants require absolute drive paths");
  if (normalized.toLowerCase() === winPath.parse(normalized).root.toLowerCase()) {
    throw new Error("Stage probe runtime and data below a drive root; drive-root read/write grants are refused");
  }
  return normalized;
}

function unique(paths) {
  return [...new Map(paths.map((entry) => [entry.toLowerCase(), entry])).values()];
}

function covers(root, directory) {
  const relative = winPath.relative(root, directory);
  return relative === "" || (!winPath.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
}

// Entry-script and cwd live in temp. The executable's dependencies live under the
// runtime directory. Only uncovered ancestors need query/list access, never file reads.
export function buildProbeFilesystem(runtime, temp, systemRoot, extraReads = []) {
  const readwritePaths = [normalizeDirectory(temp)];
  const readonlyPaths = unique([winPath.dirname(runtime), systemRoot, ...extraReads].map(normalizeDirectory));
  const granted = [...readwritePaths, ...readonlyPaths];
  const ancestors = [];
  for (const directory of granted) {
    let parent = winPath.dirname(directory);
    while (parent !== directory) {
      if (!granted.some((root) => covers(root, parent))) ancestors.push(parent);
      const next = winPath.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  return {
    filesystem: { readwritePaths, readonlyPaths, deniedPaths: [], clearPolicyOnExit: true },
    enumeratePaths: unique(ancestors),
  };
}

export function filesystemObservation(policy, entryVariant) {
  return { ancestorAccess: "query-enumerate-only", enumeratePaths: [...policy.enumeratePaths],
    driveRootRead: false, entryVariant };
}

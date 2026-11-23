export const WINDOWS_TEST_LISTS = [
  "config/windows-permission-tests.txt",
  "config/windows-native-tests.txt",
  "config/windows-application-tests.txt",
];
export const WINDOWS_INVENTORY_LOCK = "test/scripts/windows-ci-test-list.test.ts";
const MARKERS = new Map([
  ["windows-permission", WINDOWS_TEST_LISTS[0]],
  ["windows-native", WINDOWS_TEST_LISTS[1]],
]);
const HEADER = /^[ \t]*\/\/ (windows-permission|windows-native)(?:[ \t]*$|:)/u;

export function windowsTestFiles(text) {
  const files = [...new Set(text.replace(/^\uFEFF/u, "").split(/\r?\n/u).map(line => line.trim()).filter(Boolean))];
  if (files.length === 0) throw new Error("Windows test list is empty");
  for (const file of files) {
    if (!/^(?:src|test)\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
      || file.split("/").some(part => part === "." || part === "..") || /^test\/(?:e2e|screenshots|smoke)\//u.test(file)) {
      throw new Error(`Invalid unit test path: ${file}`);
    }
  }
  return files;
}

function inventoryHeader(source) {
  const markers = new Set();
  const lines = source.split("\n");
  let index = 0;
  const header = [];
  for (; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("//")) break;
    const marker = HEADER.exec(line.trimEnd())?.[1];
    if (marker) markers.add(marker);
    else header.push(line);
  }
  return { markers, body: [...header, ...lines.slice(index)].join("\n") };
}

export function hasWindowsInventoryMarker(source, marker) {
  return inventoryHeader(source).markers.has(marker);
}

export function windowsPermissionInventory(sources, isCollectedVitestFile) {
  const files = [...sources].filter(([file, source]) =>
    isCollectedVitestFile(file) && hasWindowsInventoryMarker(source, "windows-permission")).map(([file]) => file).sort();
  return `${files.join("\n")}\n`;
}

function difference(left, right) {
  return [...left].filter(value => !right.has(value));
}

/** Separate membership edits from changes to executable or general CI inputs. */
export function windowsInventoryDiff(changes, readVersion, isCollectedVitestFile) {
  const ordinary = [];
  const suites = new Map();
  let changed = false;
  function record(file, inventory) {
    const lists = suites.get(file) ?? new Set();
    lists.add(inventory);
    suites.set(file, lists);
  }

  for (const entry of changes) {
    const { path, status, oldMode, newMode } = entry;
    const isList = path === WINDOWS_TEST_LISTS[0] || path === WINDOWS_TEST_LISTS[1];
    const regularEdit = status === "M" && oldMode === "100644" && newMode === "100644";
    const isTest = isCollectedVitestFile(path);
    if ((!isList && !isTest) || !readVersion || !regularEdit) {
      ordinary.push(entry);
      // A test addition or deletion can introduce or remove a source declaration.
      if (isTest && readVersion && (status === "A" || status === "D")) {
        const source = readVersion(path, status === "A" ? "after" : "before");
        if (typeof source === "string" && inventoryHeader(source).markers.size > 0) changed = true;
      }
      continue;
    }
    const before = readVersion(path, "before");
    const after = readVersion(path, "after");
    if (typeof before !== "string" || typeof after !== "string") {
      ordinary.push(entry);
      continue;
    }
    if (isList) {
      const previous = new Set(before.trim() ? windowsTestFiles(before) : []);
      const current = new Set(after.trim() ? windowsTestFiles(after) : []);
      for (const file of [...difference(previous, current), ...difference(current, previous)]) record(file, path);
      changed = true;
      continue;
    }
    const previous = inventoryHeader(before);
    const current = inventoryHeader(after);
    const markerChanges = [...difference(previous.markers, current.markers), ...difference(current.markers, previous.markers)];
    for (const marker of markerChanges) record(path, MARKERS.get(marker));
    const markerOnly = before !== after && previous.body === current.body;
    if (markerOnly || markerChanges.length > 0) changed = true;
    if (!markerOnly) ordinary.push(entry);
  }
  return { ordinary, suites, changed };
}

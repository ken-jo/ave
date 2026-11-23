export const WINDOWS_TEST_LISTS = [
  "config/windows-permission-tests.txt",
  "config/windows-native-tests.txt",
  "config/windows-application-tests.txt",
];
export const WINDOWS_INVENTORY_LOCK = "test/scripts/windows-ci-test-list.test.ts";
export const WINDOWS_TEST_REMOVALS = "config/windows-test-removals.json";
const MARKERS = new Map([
  ["windows-permission", WINDOWS_TEST_LISTS[0]],
  ["windows-native", WINDOWS_TEST_LISTS[1]],
]);
const HEADER = /^[ \t]*\/\/ (windows-permission|windows-native)(?:[ \t]*$|:)/u;
const NON_LF_TERMINATOR = /[\r\u2028\u2029]/u;

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
    if (path === WINDOWS_TEST_REMOVALS && status === "M" && oldMode === "100644" && newMode === "100644" && readVersion) {
      changed = true;
      continue;
    }
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
    // JavaScript ends line comments at more than LF. Never strip a possible
    // executable edit as header metadata when comparing these source bytes.
    const markerOnly = before !== after && previous.body === current.body
      && !NON_LF_TERMINATOR.test(before) && !NON_LF_TERMINATOR.test(after);
    if (markerOnly || markerChanges.length > 0) changed = true;
    if (!markerOnly) ordinary.push(entry);
  }
  return { ordinary, suites, changed };
}

export function windowsCoverageDepartures(readVersion) {
  const before = new Map();
  const after = new Set();
  for (const list of WINDOWS_TEST_LISTS) {
    const oldText = readVersion(list, "before");
    const newText = readVersion(list, "after");
    for (const file of oldText === null ? [] : windowsTestFiles(oldText)) before.set(file, list);
    for (const file of newText === null ? [] : windowsTestFiles(newText)) after.add(file);
  }
  return new Map([...before].filter(([file]) => !after.has(file)).sort(([a], [b]) => a.localeCompare(b, "en")));
}

export function assertWindowsRemovalRecords(departures, readVersion) {
  const parse = side => {
    const text = readVersion(WINDOWS_TEST_REMOVALS, side);
    const records = text === null ? {} : JSON.parse(text);
    if (!records || typeof records !== "object" || Array.isArray(records)) {
      throw new Error("Windows test removal records must be an object keyed by suite path");
    }
    return records;
  };
  const before = parse("before");
  const after = parse("after");
  const problems = [];
  for (const file of departures.keys()) {
    const record = Object.hasOwn(after, file) ? after[file] : undefined;
    if (Object.hasOwn(before, file) || !record || typeof record.reason !== "string" || !record.reason.trim()
      || (record.replacement !== undefined && (typeof record.replacement !== "string"
        || !record.replacement.trim() || record.replacement === file))) {
      problems.push(file);
    }
  }
  if (problems.length) {
    throw new Error(`Last Windows lane removal needs a new record with a reason in ${WINDOWS_TEST_REMOVALS}:\n${problems.join("\n")}`);
  }
}

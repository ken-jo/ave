import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REGULAR_SHARDS = 96;
// These files create and close an independent application inside every case.
const CASES_PER_PARTITION = new Map([
  ["ui/agent-tab-pip.spec.ts", 2],
  ["ui/browser-navigation-readiness.spec.ts", 3],
  ["ui/browser-observation-preview.spec.ts", 2],
  ["ui/terminal-observation.spec.ts", 1],
]);

function collectCases(collection) {
  if (collection.errors?.length) throw new Error("Background collection contains runner errors");
  const config = collection.config;
  if (config?.fullyParallel !== false || config.workers !== 1 || config.shard != null
      || config.projects?.length !== 1 || config.projects[0].name !== "background"
      || config.projects[0].retries !== 0) {
    throw new Error("Background collection must be unsharded with one worker, ordered files and zero retries");
  }
  const cases = [];
  const visit = (suite, parents) => {
    for (const spec of suite.specs ?? []) {
      if (spec.tests?.length !== 1 || spec.tests[0].projectName !== "background") {
        throw new Error("Background collection contains an unexpected project");
      }
      const file = spec.file.replaceAll("\\", "/");
      const titlePath = [...parents, spec.title];
      const tokens = [file, ...titlePath];
      if (tokens.some(token => typeof token !== "string" || !token.trim()
          || token !== token.trim() || /[\r\n›]/.test(token))) {
        throw new Error("Background collection contains an ambiguous test selector");
      }
      if (typeof spec.id !== "string" || !spec.id) throw new Error("Background case ID is missing");
      cases.push({ id: spec.id, file, selector: `[background] › ${tokens.join(" › ")}` });
    }
    for (const child of suite.suites ?? []) visit(child, [...parents, child.title]);
  };
  for (const suite of collection.suites ?? []) visit(suite, []);
  if (!cases.length) throw new Error("Background collection is empty");
  if (new Set(cases.map(test => test.id)).size !== cases.length) throw new Error("Duplicate background case ID");
  if (new Set(cases.map(test => test.selector)).size !== cases.length) throw new Error("Duplicate background test selector");
  if (cases.some(test => cases.some(other => other.selector.startsWith(`${test.selector} › `)))) {
    throw new Error("Background collection contains a test selector that also selects a nested case");
  }
  return cases;
}

export function planBackgroundShards(collection) {
  const cases = collectCases(collection);
  const regularCases = cases.filter(test => !CASES_PER_PARTITION.has(test.file));
  const matrix = { include: Array.from({ length: REGULAR_SHARDS }, (_, index) => ({
    id: index + 1, regularShard: index + 1, testList: "",
  })) };
  const specialPartitions = [];
  const lists = { "special-files.txt": `${[...CASES_PER_PARTITION.keys()].map(file => `[background] › ${file}`).join("\n")}\n` };
  for (const [file, size] of CASES_PER_PARTITION) {
    const tests = cases.filter(test => test.file === file);
    if (!tests.length) throw new Error(`Partitioned test file was not collected: ${file}`);
    for (let offset = 0; offset < tests.length; offset += size) {
      const group = tests.slice(offset, offset + size);
      const id = matrix.include.length + 1;
      const testList = `partition-${id}.txt`;
      matrix.include.push({ id, regularShard: 0, testList });
      lists[testList] = `${group.map(test => test.selector).join("\n")}\n`;
      specialPartitions.push({ id, file, testList, testIds: group.map(test => test.id) });
    }
  }
  const selectedIds = cases.map(test => test.id);
  const assignedIds = [...regularCases.map(test => test.id), ...specialPartitions.flatMap(partition => partition.testIds)];
  if (assignedIds.length !== selectedIds.length || new Set(assignedIds).size !== selectedIds.length
      || assignedIds.some(id => !selectedIds.includes(id))) {
    throw new Error("Background partitions must cover every collected case exactly once");
  }
  if (matrix.include.length > 256) throw new Error("Background partition count exceeds the matrix limit");
  return {
    matrix,
    lists,
    manifest: {
      project: "background",
      regularShards: REGULAR_SHARDS,
      totalPartitions: matrix.include.length,
      selectedTests: cases.length,
      collectionFile: "collection.json",
      regularTestIds: regularCases.map(test => test.id),
      specialPartitions,
    },
  };
}

export function writeBackgroundShardPlan(collectionPath, outputDirectory, githubOutput) {
  const collection = JSON.parse(readFileSync(collectionPath, "utf8"));
  const plan = planBackgroundShards(collection);
  mkdirSync(outputDirectory, { recursive: true });
  for (const [name, content] of Object.entries(plan.lists)) writeFileSync(resolve(outputDirectory, name), content);
  writeFileSync(resolve(outputDirectory, "collection.json"), `${JSON.stringify(collection, null, 2)}\n`);
  writeFileSync(resolve(outputDirectory, "manifest.json"), `${JSON.stringify({ ...plan.manifest, commit: process.env.GITHUB_SHA ?? null, matrix: plan.matrix }, null, 2)}\n`);
  if (githubOutput) appendFileSync(githubOutput, `matrix=${JSON.stringify(plan.matrix)}\npartitions=${plan.manifest.totalPartitions}\nregular-shards=${plan.manifest.regularShards}\n`);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , collectionPath, outputDirectory] = process.argv;
  if (!collectionPath || !outputDirectory) throw new Error("Expected a collection file and partition output directory");
  writeBackgroundShardPlan(collectionPath, outputDirectory, process.env.GITHUB_OUTPUT);
}

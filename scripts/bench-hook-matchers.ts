/** Informational only: node --import tsx --import ./scripts/lib/stub-app-logger-hook.mjs scripts/bench-hook-matchers.ts */
import { performance } from "node:perf_hooks";
import { compileHookMatcher } from "../src/hooks/hook-discovery.js";

const PATTERNS = [
  "a{0,256}a{0,256}b",
  "a{0,256}a{0,256}\\x62" + "(?:)".repeat(59),
  "^a{0,256}a{0,256}a{0,256}b",
  "^a{0,256}a{0,256}a{0,256}b" + "(?:)".repeat(57) + "()",
  "(?:a|aa)a{0,256}b",
  "^(?:a|aa)a{0,256}a{0,256}b",
  "(?:a|aa)(?:a|aa)!",
  "^(?:a|aa)(?:a|aa)(?:a|aa)!",
];
const SUBJECT = "a".repeat(256);
const ITERATIONS = 100;

if (process.versions.bun) throw new Error("Run this benchmark under Node");
console.log(`Node ${process.versions.node}, V8 ${process.versions.v8}; informational timings, no budget assertion`);
for (const pattern of PATTERNS) {
  const predicate = compileHookMatcher(pattern);
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    const matched = predicate(SUBJECT);
    times.push(performance.now() - start);
    if (matched) throw new Error("Expected a non-matching benchmark subject");
  }
  const steady = times.slice(1).sort((a, b) => a - b);
  console.log(`pattern=${pattern.length} subject=${SUBJECT.length} iterations=${ITERATIONS} cold=${times[0].toFixed(3)}ms steady-median=${steady[Math.floor(steady.length / 2)].toFixed(3)}ms max=${Math.max(...times).toFixed(3)}ms ${JSON.stringify(pattern)}`);
}

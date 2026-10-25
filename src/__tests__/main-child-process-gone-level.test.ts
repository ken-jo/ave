/** Inspect source because importing the main entry registers listeners. Shutdown child exits must not hide real crashes in error noise. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("main.ts — child-process-gone log level", () => {
  const source = readFileSync("src/main.ts", "utf-8").replace(/\r\n/g, "\n");

  function handlerBody(): string {
    const open = source.indexOf('app.on("child-process-gone"');
    expect(open, "child-process-gone handler not found").toBeGreaterThan(-1);
    // Balance callback braces so later handlers cannot satisfy this handler's assertions.
    const start = source.indexOf("{", open);
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error("unbalanced child-process-gone handler");
  }

  it("is guarded by the shutdown state before it logs", () => {
    const body = handlerBody();

    expect(body).toMatch(/log\.info\(/);
    expect(body).toMatch(/log\.error\(/);

    expect(body).toMatch(/isAppShutdownStarted\(\)/);
    expect(body).toMatch(/isAppShutdownCompleted\(\)/);
  });

  it("takes the info path before the error path", () => {
    const body = handlerBody();
    const guard = body.search(/isAppShutdownStarted\(\)/);
    const info = body.search(/log\.info\(/);
    const error = body.search(/log\.error\(/);

    expect(guard).toBeGreaterThan(-1);
    expect(info).toBeGreaterThan(guard);
    expect(error).toBeGreaterThan(info);
  });

  it("still reports a crash outside shutdown at error level", () => {
    const body = handlerBody();
    const ret = body.search(/\breturn;/);
    const error = body.search(/log\.error\(/);
    expect(ret).toBeGreaterThan(-1);
    expect(error).toBeGreaterThan(ret);
  });
});

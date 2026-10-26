import { expect } from "vitest";
import type { useBashStructuralFixture } from "../../../__tests__/support/bash-structural.js";

type ValidateCommand = ReturnType<typeof useBashStructuralFixture>["validate"];

export function allowedCommandCase(validate: ValidateCommand) {
  return (command: string) => {
    const result = validate(command);
    expect(result.decision).toBe("allow");
  };
}

export function deniedCommandCase(validate: ValidateCommand, patternId: string) {
  return (command: string) => {
    const result = validate(command);
    expect(result.decision).toBe("deny");
    expect(result.patternId).toBe(patternId);
  };
}

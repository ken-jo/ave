export const SHELL_FLOOR_WORK_LIMITS = Object.freeze({ steps: 16_384, chars: 65_536, commandTokens: 64, stepsPerChar: 128, charsPerChar: 128 });

export class ShellFloorWorkBudgetError extends Error {}

export class ShellFloorWorkBudget {
  steps = 0;
  chars = 0;
  exhausted = false;
  private stepLimit: number = SHELL_FLOOR_WORK_LIMITS.steps;
  private charLimit: number = SHELL_FLOOR_WORK_LIMITS.chars;
  private entered = false;

  // The first input fixes this decision's linear ceiling. Nested text consumes it.
  enterSource(source: string): void {
    if (!this.entered) {
      this.entered = true;
      this.stepLimit = Math.max(this.stepLimit, source.length * SHELL_FLOOR_WORK_LIMITS.stepsPerChar);
      this.charLimit = Math.max(this.charLimit, source.length * SHELL_FLOOR_WORK_LIMITS.charsPerChar);
    }
    this.spend(0, source.length);
  }

  parserWorkLimits(source: string): { commandWords: number; lexerSteps: number; onLexerSteps: (steps: number) => void } {
    this.enterSource(source);
    const remaining = this.stepLimit - this.steps;
    if (remaining <= 0) this.exceed();
    return { commandWords: SHELL_FLOOR_WORK_LIMITS.commandTokens,
      lexerSteps: remaining, onLexerSteps: (steps) => this.spend(steps) };
  }

  checkCommandTokens(tokens: number): void {
    if (tokens > SHELL_FLOOR_WORK_LIMITS.commandTokens) this.exceed();
  }

  spend(steps = 1, chars = 0): void {
    if (this.exhausted || this.steps + steps > this.stepLimit || this.chars + chars > this.charLimit) this.exceed();
    this.steps += steps;
    this.chars += chars;
  }

  private exceed(): never {
    this.exhausted = true;
    throw new ShellFloorWorkBudgetError("Shell floor analysis budget exceeded");
  }
}

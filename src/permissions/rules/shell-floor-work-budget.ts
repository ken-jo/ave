export const SHELL_FLOOR_WORK_LIMITS = Object.freeze({ steps: 16_384, chars: 65_536 });

export class ShellFloorWorkBudgetError extends Error {}

export class ShellFloorWorkBudget {
  steps = 0;
  chars = 0;
  exhausted = false;

  reserveSource(source: string): void {
    this.spend(1, source.length);
    // Parsing and materializing a source span includes token, location and syntax records.
    let span = false;
    for (const char of source) {
      const content = !/\s/.test(char);
      if (content && !span) this.spend(64);
      span = content;
    }
  }

  spend(steps = 1, chars = 0): void {
    if (this.exhausted || this.steps + steps > SHELL_FLOOR_WORK_LIMITS.steps || this.chars + chars > SHELL_FLOOR_WORK_LIMITS.chars) {
      this.exhausted = true;
      throw new ShellFloorWorkBudgetError("Shell floor analysis budget exceeded");
    }
    this.steps += steps;
    this.chars += chars;
  }
}

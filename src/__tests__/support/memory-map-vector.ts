export function vector(x = 1): number[] {
  return [x, Math.sqrt(1 - x * x), ...Array<number>(382).fill(0)];
}

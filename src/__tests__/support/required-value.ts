export function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required fixture value is missing");
  return value;
}

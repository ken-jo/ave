/** Refuse a missing fixture before exercising the behavior under test. */
export function requiredFixture<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required fixture is missing");
  return value;
}

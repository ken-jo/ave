/** Evidence from a host validation or scope check inside a tool. The executor
 * accepts it by identity so external tool results cannot claim a host refusal. */
const hostRefusals = new WeakSet<object>();

export function markHostRefusal<T extends object>(value: T): T {
  hostRefusals.add(value);
  return value;
}

export function isHostRefusal(value: object): boolean {
  return hostRefusals.has(value);
}

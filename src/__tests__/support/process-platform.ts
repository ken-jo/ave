/** Override platform per test to exercise platform branches from any host. */
export function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

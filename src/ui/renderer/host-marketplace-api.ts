import type { AveHostMarketplaceApi } from "./types.js";

let claimedMarketplaceApi: AveHostMarketplaceApi | null | undefined;

function claimMarketplaceApi(): AveHostMarketplaceApi | null {
  if (claimedMarketplaceApi !== undefined) {
    return claimedMarketplaceApi;
  }
  claimedMarketplaceApi = window.aveHost?.takePluginMarketplaceApi() ?? null;
  return claimedMarketplaceApi;
}

export function primeHostMarketplaceApi(): void {
  claimMarketplaceApi();
}

export function getHostMarketplaceApi(): AveHostMarketplaceApi {
  const api = claimMarketplaceApi();
  if (!api) {
    throw new Error("Host marketplace API unavailable");
  }
  return api;
}

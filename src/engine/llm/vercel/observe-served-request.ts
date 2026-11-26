function requestAddress(input: Parameters<typeof fetch>[0]): string | undefined {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
  } catch {
    return undefined;
  }
}

/**
 * Reports the response address after redirects. The request address is used only
 * when the transport supplies no response address and reports no redirect.
 */
export function observeServedRequest(
  fetchImpl: typeof fetch,
  onServedRequest: (servedAddress: string | undefined) => void,
): typeof fetch {
  return async (input, init) => {
    // An earlier attempt of this call no longer says where the answer comes from.
    onServedRequest(undefined);
    const response = await fetchImpl(input, init);
    onServedRequest(response.url || (response.redirected ? undefined : requestAddress(input)));
    return response;
  };
}

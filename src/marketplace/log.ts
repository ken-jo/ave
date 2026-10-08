/**
 * The marketplace's logger: `createLogger` with every string it is handed
 * scrubbed first. A log line quotes paths, addresses, refs and remote
 * messages as the renderer's answers do, and the same one scrubber applies
 * (`scrubMarketplaceStrings`, design §18.8), so a token never reaches the
 * console or the log file from the marketplace.
 */
import { createLogger } from "../lib/logger.js";
import { scrubMarketplaceStrings } from "./errors.js";

type LogMethod = (objectOrMessage: unknown, message?: string) => void;

export interface MarketplaceLogger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

export function createMarketplaceLogger(module: string): MarketplaceLogger {
  const log = createLogger(module);
  const scrubbed = (level: keyof MarketplaceLogger): LogMethod => (objectOrMessage, message) => {
    const first = scrubMarketplaceStrings(objectOrMessage);
    if (message === undefined) log[level](first as string);
    else log[level](first as object, scrubMarketplaceStrings(message));
  };
  return { debug: scrubbed("debug"), info: scrubbed("info"), warn: scrubbed("warn"), error: scrubbed("error") };
}

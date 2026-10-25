/** Scrub every logged string, including remote messages and identifiers, before it reaches any sink. */
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

/** Guide queues text for the next round boundary without interrupting tools; abort-then-start replaces the current turn. */
export type ChatUtteranceMode =
  | "start"
  | "abort-then-start"
  | "guide"
  | "stop";

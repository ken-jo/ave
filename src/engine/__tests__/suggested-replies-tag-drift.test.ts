// Tolerate suggestion-tag spelling drift across all consumers without leaking markup.
import { describe, expect, it } from "vitest";

import {
  createStreamingFilter,
  parseSuggestedReply,
  stripSuggestedReplies,
} from "../suggested-replies.js";

const DRIFTED_OPEN = [
  "< suggested_replies>",
  "<suggested_replies >",
  "< suggested_replies >",
  "<\nsuggested_replies>",
] as const;

const DRIFTED_CLOSE = [
  "</ suggested_replies>",
  "< /suggested_replies>",
  "</suggested_replies >",
] as const;

function block(open: string, close: string): string {
  return `${open}\n- first reply\n${close}`;
}

describe("suggested-replies tag drift", () => {
  it.each(DRIFTED_OPEN)("parses a block opened with %j", (open) => {
    expect(parseSuggestedReply(block(open, "</suggested_replies>"))).toBe("first reply");
  });

  it.each(DRIFTED_CLOSE)("parses a block closed with %j", (close) => {
    expect(parseSuggestedReply(block("<suggested_replies>", close))).toBe("first reply");
  });

  it.each(DRIFTED_OPEN)("strips a drifted block from persisted text (%j)", (open) => {
    const raw = `answer text\n\n${block(open, "</suggested_replies>")}`;
    const stripped = stripSuggestedReplies(raw);
    expect(stripped).toBe("answer text");
    // Suggestion markup must not persist and replay into later model context.
    expect(stripped).not.toMatch(/suggested_replies/);
  });

  it.each(DRIFTED_OPEN)("withholds a drifted block from the visible stream (%j)", (open) => {
    const filter = createStreamingFilter();
    const visible =
      filter.feed("answer text\n\n") + filter.feed(block(open, "</suggested_replies>"));
    // Earlier emitted chunks cannot be trimmed retroactively; compare content, not trailing whitespace.
    expect(visible).toContain("answer text");
    expect(visible).not.toMatch(/suggested_replies|first reply/);
    expect(filter.finish().suggestedReply).toBe("first reply");
  });

  it("holds back a drifted tag split across chunks", () => {
    // Buffer partial tag prefixes so later recognition cannot leave a leaked opening fragment.
    const filter = createStreamingFilter();
    let visible = filter.feed("answer text\n\n< sugg");
    expect(visible).not.toContain("<");
    visible += filter.feed("ested_replies>\n- only reply\n</suggested_replies>");
    expect(visible).toContain("answer text");
    expect(visible).not.toMatch(/suggested_replies|only reply/);
    expect(filter.finish().suggestedReply).toBe("only reply");
  });

  it("does not hold back ordinary text that merely starts with a bracket", () => {
    // Tolerant matching must not swallow ordinary markup such as <b.
    const filter = createStreamingFilter();
    const visible = filter.feed("compare <b> and <i>");
    expect(visible).toBe("compare <b> and <i>");
  });

  it("does not buffer without bound after a stray bracket", () => {
    // Bound whitespace after < so a partial tag cannot hold the rest of the stream.
    const filter = createStreamingFilter();
    const visible = filter.feed(`start <${" ".repeat(200)}not a tag`);
    expect(visible).toContain("start");
    expect(visible).toContain("not a tag");
  });
});

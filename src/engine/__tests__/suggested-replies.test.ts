import { describe, it, expect } from "vitest";
import {
  createStreamingFilter,
  parseSuggestedReply,
  stripSuggestedReplies,
} from "../suggested-replies.js";

describe("parseSuggestedReply", () => {
  it("returns null when no block is present", () => {
    expect(parseSuggestedReply("plain text response")).toBeNull();
  });

  it("extracts the single candidate", () => {
    const raw = [
      "응답 본문.",
      "",
      "<suggested_replies>",
      "- 다음 단계로 진행",
      "</suggested_replies>",
    ].join("\n");
    expect(parseSuggestedReply(raw)).toBe("다음 단계로 진행");
  });

  it("keeps only the first candidate when the model still lists alternatives", () => {
    const raw =
      "<suggested_replies>\n- 다음 단계로 진행\n- 다른 옵션 보기\n- 취소\n</suggested_replies>";
    expect(parseSuggestedReply(raw)).toBe("다음 단계로 진행");
  });

  it("skips blank lines inside the block", () => {
    const raw = "<suggested_replies>\n\n- a\n</suggested_replies>";
    expect(parseSuggestedReply(raw)).toBe("a");
  });

  it("skips a candidate over 80 characters (parser safety cap above 40~60자 recommended length)", () => {
    const tooLong = "x".repeat(90);
    const raw = `<suggested_replies>\n- ${tooLong}\n- ok\n</suggested_replies>`;
    expect(parseSuggestedReply(raw)).toBe("ok");
  });

  it("returns null when every candidate is over 80 characters", () => {
    const tooLong = "x".repeat(90);
    expect(parseSuggestedReply(`<suggested_replies>\n- ${tooLong}\n</suggested_replies>`)).toBeNull();
  });

  it("tolerates bullet variants (•, *, dash, spaces)", () => {
    expect(parseSuggestedReply("<suggested_replies>\n* a\n</suggested_replies>")).toBe("a");
    expect(parseSuggestedReply("<suggested_replies>\n• b\n</suggested_replies>")).toBe("b");
    expect(parseSuggestedReply("<suggested_replies>\n  -   c\n</suggested_replies>")).toBe("c");
  });
});

describe("stripSuggestedReplies", () => {
  it("removes the trailing block and surrounding whitespace", () => {
    const raw = "본문입니다.\n\n<suggested_replies>\n- a\n- b\n</suggested_replies>";
    expect(stripSuggestedReplies(raw)).toBe("본문입니다.");
  });

  it("is a no-op when no block exists", () => {
    expect(stripSuggestedReplies("그냥 텍스트")).toBe("그냥 텍스트");
  });

  it("removes a mid-text block (defensive — should not happen in practice)", () => {
    // Malformed tags must not reach the user, even if stripping alters surrounding whitespace.
    const raw = "before\n<suggested_replies>\n- x\n</suggested_replies>\nafter";
    expect(stripSuggestedReplies(raw)).toBe("beforeafter");
  });

  it("strips an unclosed trailing block (vendor malformation guard)", () => {
    // Strip unterminated blocks before persistence so they cannot replay into later turns.
    const raw = "본문\n<suggested_replies>\n- a";
    expect(stripSuggestedReplies(raw)).toBe("본문");
  });

  it("removes multiple blocks (defensive — model malformation or history echo)", () => {
    const raw = [
      "본문",
      "<suggested_replies>",
      "- old",
      "</suggested_replies>",
      "<suggested_replies>",
      "- new",
      "</suggested_replies>",
    ].join("\n");
    expect(stripSuggestedReplies(raw)).toBe("본문");
  });
});

describe("createStreamingFilter", () => {
  function feedAll(filter: ReturnType<typeof createStreamingFilter>, chunks: string[]): string {
    return chunks.map((c) => filter.feed(c)).join("");
  }

  it("passes plain text through unchanged", () => {
    const f = createStreamingFilter();
    expect(feedAll(f, ["hello ", "world"])).toBe("hello world");
    expect(f.finish()).toEqual({ trailing: "", suggestedReply: null });
  });

  it("withholds the tag and emits the parsed reply at finish()", () => {
    const f = createStreamingFilter();
    const visible = feedAll(f, [
      "본문",
      "\n\n<suggested_replies>\n- 예\n</suggested_replies>",
    ]);
    expect(visible).toBe("본문");
    expect(f.finish()).toEqual({ trailing: "", suggestedReply: "예" });
  });

  it("handles the open tag split across chunk boundaries", () => {
    const f = createStreamingFilter();
    expect(f.feed("body text <sugg")).toBe("body text ");
    expect(f.feed("ested_replies>\n- ok\n</suggested_replies>")).toBe("");
    expect(f.finish().suggestedReply).toBe("ok");
  });

  it("treats a partial-tag suffix that turns out to be plain text as visible", () => {
    const f = createStreamingFilter();
    expect(f.feed("see <sugg")).toBe("see ");
    expect(f.feed("ar in coffee")).toBe("<suggar in coffee");
    expect(f.finish()).toEqual({ trailing: "", suggestedReply: null });
  });

  it("returns trailing pending on stream end without a block", () => {
    const f = createStreamingFilter();
    expect(f.feed("done <sug")).toBe("done ");
    expect(f.finish()).toEqual({ trailing: "<sug", suggestedReply: null });
  });

  it("drops the partial block silently when the stream aborts mid-block", () => {
    const f = createStreamingFilter();
    expect(f.feed("hi\n<suggested_replies>\n- a")).toBe("hi");
    expect(f.finish()).toEqual({ trailing: "", suggestedReply: null });
  });
});

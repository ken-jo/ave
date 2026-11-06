import { describe, expect, it } from "vitest";
import { routeInput } from "../route-input.js";

describe("routeInput", () => {
  it("parses host slash commands and trims their arguments", () => {
    const result = routeInput("  /compact   now please  ");

    expect(result).toEqual({
      route: "command",
      command: "compact",
      args: "now please",
    });
  });

  it("treats natural-language Skill and Tool names as general model input", () => {
    const result = routeInput("회의록을 읽고 이메일을 보내줘");

    expect(result).toEqual({
      route: "llm",
      input: "회의록을 읽고 이메일을 보내줘",
    });
  });

  it("does not interpret command-looking text inside imported plugin envelopes", () => {
    const envelope =
      `<imported-from-proactive source="overlay:meeting-detection">\n` +
      `/compact 회의 요청 이메일이 도착했습니다.\n` +
      `</imported-from-proactive>`;

    expect(routeInput(envelope)).toEqual({
      route: "llm",
      input: envelope,
    });
  });

  it("does not interpret command-looking text inside MCP app envelopes", () => {
    const envelope = `<app-message source="app:acme-cards">/compact now</app-message>`;

    expect(routeInput(envelope)).toEqual({
      route: "llm",
      input: envelope,
    });
  });

  it("does not grant envelope semantics to malformed or embedded text", () => {
    const malformed =
      `<imported-from-proactive source="Proactive:bad">/compact now</imported-from-proactive>`;
    const embedded =
      `prefix <imported-from-proactive source="overlay:x">/compact now</imported-from-proactive>`;

    expect(routeInput(malformed)).toEqual({
      route: "llm",
      input: malformed,
    });
    expect(routeInput(embedded)).toEqual({
      route: "llm",
      input: embedded,
    });
  });
  it("routes general input through the llm route", () => {
    expect(routeInput("상태 알려줘")).toEqual({ route: "llm", input: "상태 알려줘" });
  });

  it("routes host commands without consulting Tool state", () => {
    expect(routeInput("/compact now")).toEqual({ route: "command", command: "compact", args: "now" });
  });
});

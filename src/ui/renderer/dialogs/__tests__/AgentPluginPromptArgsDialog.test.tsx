// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentPluginPromptArgsDialog } from "../AgentPluginPromptArgsDialog.js";

const prompt = {
  id: "agent-plugin:writer-plugin:draft", packageName: "writer-plugin", version: "1.0.0",
  name: "draft", description: "Draft a note", argumentHint: "Topic", body: "Draft {args}",
};

describe("agent plugin prompt arguments", () => {
  it("keeps user text in the prompt form and submits it to the selected package", () => {
    const onSubmit = vi.fn();
    render(<AgentPluginPromptArgsDialog prompt={prompt} onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("agent-plugin-prompt-args"), { target: { value: "Quarterly plan" } });
    fireEvent.submit(screen.getByTestId("agent-plugin-prompt-args-dialog").querySelector("form")!);
    expect(onSubmit).toHaveBeenCalledWith(prompt, "Quarterly plan");
  });
});

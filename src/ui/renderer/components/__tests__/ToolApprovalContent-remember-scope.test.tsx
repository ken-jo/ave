// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import type { ApprovalMemory } from "../../../../shared/permissions-events.js";

/**
 * The "remember" line states the scope the store will actually apply — read
 * from the host-derived `approvalMemory`, one line per memory mode. The
 * renderer test setup runs in the Korean locale.
 */
function request(toolName: string, approvalMemory: ApprovalMemory | undefined): ApprovalRequest {
  return {
    id: `remember-${toolName}`,
    category: "tool",
    kind: "tool",
    toolName,
    toolCategory: "write",
    args: {},
    reason: "remember scope",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    trustOrigin: "user-keyboard",
    persistentAllowAllowed: true,
    persistentApprovalCwd: "/workspace/project",
    ...(approvalMemory === undefined ? {} : { approvalMemory }),
  };
}

function scopeLine(req: ApprovalRequest): string {
  render(<ToolApprovalContent conversationLabel="conversation" open request={req} onDecide={vi.fn()} />);
  return screen.getByTestId("allow-always-exact-scope").textContent ?? "";
}

describe("ToolApprovalContent remember scope", () => {
  afterEach(() => cleanup());

  it("says exact arguments in args mode and when no memory is attached", () => {
    expect(scopeLine(request("routine_schedule", { kind: "args" })))
      .toBe("이 도구와 동일한 인자만 다음 작업 경로에서 기억합니다: /workspace/project");
    cleanup();
    expect(scopeLine(request("routine_schedule", undefined))).toContain("동일한 인자만");
  });

  it("names the origin for a web_fetch origin scope", () => {
    const line = scopeLine(request("web_fetch", {
      kind: "key", key: "k", scope: { kind: "origin", origin: "https://a.example:443" },
    }));
    expect(line).toContain("https://a.example:443에 대한 모든 web_fetch 요청");
    expect(line).not.toContain("동일한 인자만");
  });

  it("names the tool and path for a path scope", () => {
    expect(scopeLine(request("write_file", {
      kind: "key", key: "k", scope: { kind: "path", path: "/workspace/project/notes.md" },
    }))).toContain("/workspace/project/notes.md에 대한 write_file을(를) 내용과 관계없이");
  });

  it("distinguishes a transfer with and without overwrite", () => {
    const scope = { kind: "transfer" as const, sourcePath: "/w/a", destinationPath: "/w/b" };
    expect(scopeLine(request("move_file", { kind: "key", key: "k", scope: { ...scope, overwrite: false } })))
      .toContain("/w/a에서 /w/b(으)로의 move_file을(를) 덮어쓰기 없이");
    cleanup();
    expect(scopeLine(request("move_file", { kind: "key", key: "k", scope: { ...scope, overwrite: true } })))
      .toContain("대상 덮어쓰기와 함께");
  });

  it("says this exact command for a shell command scope", () => {
    expect(scopeLine(request("bash", {
      kind: "key", key: "k", scope: { kind: "command", commandSha256: "a".repeat(64), cwd: null },
    }))).toContain("이 명령 그대로를 타임아웃과 관계없이");
  });
});

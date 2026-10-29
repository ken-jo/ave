// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { selectDecision } from "./support/decision-bar.js";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import type { ApprovalMemory } from "../../../../shared/permissions-events.js";

/** The "remember" line states the scope the store will actually apply — read from the host-derived `approvalMemory`, one
 * line per memory mode. The renderer test setup runs in the Korean locale. */
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
  renderApproval(req, vi.fn());
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
    expect(line).toContain("https://a.example:443에 대한 web_fetch 요청을");
    // The card promises reuse only after a risk check — true with a reviewer (fresh review) and without one (rules-only reuse
    // of a rules-only row).
    expect(line).toContain("새 경로나 쿼리는 먼저 위험도를 확인하고, 더 위험해 보이면 다시 묻습니다");
    expect(line).not.toContain("동일한 인자만");
  });

  it.each(["write_file", "edit_file", "multi_edit", "apply_patch"])("discloses the shared text-write tools for builtin %s path memory", (toolName) => {
    const line = scopeLine(request(toolName, {
      kind: "key", key: "file-write-path:k", scope: { kind: "path", path: "/workspace/project/notes.md" },
    }));
    expect(line).toContain("/workspace/project/notes.md에 대한 write_file, edit_file, multi_edit, apply_patch 작업을 다음 작업 경로에서 기억합니다: /workspace/project");
    expect(line).toContain("내용이 다르면 먼저 위험도를 확인하고");
  });

  it.each(["plugin", "mcp"] as const)("keeps %s tool path memory specific to its tool", (source) => {
    const line = scopeLine({ ...request("write_file", {
      kind: "key", key: "file-write-path:k", scope: { kind: "path", path: "/workspace/project/notes.md" },
    }), source });
    expect(line).toContain("write_file 작업을");
    expect(line).not.toContain("edit_file");
  });

  it("keeps other builtin path tools specific to their tool", () => {
    const line = scopeLine(request("delete_file", {
      kind: "key", key: "k", scope: { kind: "path", path: "/workspace/project/notes.md" },
    }));
    expect(line).toContain("delete_file 작업을");
    expect(line).not.toContain("write_file");
  });

  it("does not advertise sharing for a non-shared memory identity", () => {
    const line = scopeLine(request("write_file", {
      kind: "key", key: "tool-specific:k", scope: { kind: "path", path: "/workspace/project/notes.md" },
    }));
    expect(line).toContain("write_file 작업을");
    expect(line).not.toContain("edit_file");
  });

  it.each(["apply_patch:k", "file-write-path:k"])("keeps a multi-file patch scope specific to its tool for %s", (key) => {
    const line = scopeLine(request("apply_patch", {
      kind: "key", key, scope: { kind: "paths", paths: ["/workspace/project/a,b.md", "/workspace/project/b.md"] },
    }));
    expect(line).toContain('"/workspace/project/a,b.md", "/workspace/project/b.md"');
    expect(line).toContain("apply_patch 작업을");
    expect(line).not.toContain("write_file");
  });

  it("distinguishes a transfer with and without overwrite", () => {
    const scope = { kind: "transfer" as const, sourcePath: "/w/a", destinationPath: "/w/b" };
    expect(scopeLine(request("move_file", { kind: "key", key: "k", scope: { ...scope, overwrite: false } })))
      .toContain("/w/a에서 /w/b(으)로의 move_file을(를) 덮어쓰기 없이");
    cleanup();
    expect(scopeLine(request("move_file", { kind: "key", key: "k", scope: { ...scope, overwrite: true } })))
      .toContain("대상 덮어쓰기와 함께");
  });

  it("discloses that a server tool approval covers all arguments", () => {
    const line = scopeLine({ ...request("mcp_catalog_update", {
      kind: "key", key: "tool-memory", scope: { kind: "mcp-tool", serverId: "catalog", toolName: "update" },
    }), source: "mcp" });
    expect(line).toContain("catalog 서버의 이 도구(update)를 모든 인자에 대해");
    expect(line).toContain("/workspace/project");
    expect(line).toContain("한 번 허용은 현재 호출에만 적용");
    expect(line).toContain("거부·확인 규칙과 필수 승인은 유지");
    expect(line).not.toContain("동일한 인자만");
  });

  it("discloses the same tool-wide scope when remembered across projects", () => {
    scopeLine({ ...request("mcp_catalog_update", { kind: "key", key: "tool-memory", scope: { kind: "mcp-tool", serverId: "catalog", toolName: "update" } }), source: "mcp" });
    selectDecision("allow-everywhere");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("모든 인자와 작업 경로에서 기억");
    expect(screen.getByTestId("allow-always-exact-scope")).not.toHaveTextContent("동일한 인자만");
  });

  it("says this exact command for a shell command scope", () => {
    expect(scopeLine(request("bash", {
      kind: "key", key: "k", scope: { kind: "command", commandSha256: "a".repeat(64), cwd: null },
    }))).toContain("이 명령 그대로를 타임아웃과 관계없이");
  });
});

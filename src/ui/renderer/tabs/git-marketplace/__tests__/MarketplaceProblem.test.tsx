/** Policy blocks, warnings ask for confirmation, and errors state the recovery action. */
// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { Component, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MarketplaceError } from "../../../../../marketplace/errors.js";
import { normalizeSourceUrl } from "../../../../../marketplace/net/source-url.js";
import { parseGitMarketplaceResult } from "../../../../../shared/git-marketplace.js";
import { breakDiagnosticScrubberOn, DIAGNOSTIC_KEPT, DIAGNOSTIC_SECRET_PROBES } from "../../../../../shared/__tests__/fixtures/diagnostic-secret-probes.js";
import { ENTRY_SUBJECT } from "../labels.js";
import { MarketplaceProblem } from "../MarketplaceProblem.js";

/** Stands in for the tab's ErrorBoundary: a scrubber throw during render would show its fallback. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <p data-testid="boundary">crashed</p> : this.props.children;
  }
}

function clipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("MarketplaceProblem", () => {
  it("shows a source policy block as the organization's rule, without a way to continue", () => {
    const writeText = clipboard();
    render(
      <MarketplaceProblem
        testId="problem"
        subject={ENTRY_SUBJECT} failure={{
          code: "SOURCE_POLICY_BLOCKED",
          message: "blocked by managed policy: https://github.com/acme/market",
          detail: { reason: "blocked-by-pattern", target: "https://github.com/acme/market", pattern: "host:github.com", policyPath: "/Library/Ave/policy.json" },
        }}
      />,
    );

    const problem = screen.getByTestId("problem");
    expect(problem).toHaveAttribute("data-tone", "policy");
    expect(problem).toHaveTextContent("조직에서 설정함");
    expect(problem).toHaveTextContent("조직 정책이 https://github.com/acme/market을(를) 차단합니다(규칙 host:github.com).");
    expect(problem).toHaveTextContent("/Library/Ave/policy.json");
    expect(screen.queryByRole("button", { name: "계속" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
    expect(writeText).toHaveBeenCalledWith("SOURCE_POLICY_BLOCKED · blocked-by-pattern\nblocked by managed policy: https://github.com/acme/market");
  });

  it("asks before a warning's risk, and answers Continue or Cancel", () => {
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    render(<MarketplaceProblem tone="warning" testId="problem" text="The connection is not encrypted." onContinue={onContinue} onCancel={onCancel} />);

    expect(screen.getByTestId("problem")).toHaveAttribute("data-tone", "warning");
    fireEvent.click(screen.getByRole("button", { name: "계속" }));
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reads a failure a confirmation resolves as a warning, with the caller's Allow…, and offers none without one", () => {
    const onAllow = vi.fn();
    const failure = { code: "SOURCE_CONFIRMATION_REQUIRED" as const, message: "needs internal-network", detail: { reason: "internal-network" as const, host: "git.corp.example", address: "10.0.0.5" } };
    const { unmount } = render(<MarketplaceProblem testId="problem" subject={ENTRY_SUBJECT} failure={failure} onAllow={onAllow} />);
    expect(screen.getByTestId("problem")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByTestId("problem")).toHaveTextContent("git.corp.example은(는) 사내망 주소(10.0.0.5)입니다.");
    fireEvent.click(screen.getByTestId("problem:allow"));
    expect(onAllow).toHaveBeenCalledTimes(1);
    unmount();

    // Sign-in over http is resolved the same way.
    render(<MarketplaceProblem testId="auth" subject={ENTRY_SUBJECT} failure={{ code: "SOURCE_AUTH_REQUIRED", message: "", detail: { reason: "token-unencrypted", host: "git.corp.example" } }} />);
    expect(screen.getByTestId("auth")).toHaveAttribute("data-tone", "warning");
    expect(screen.queryByTestId("auth:allow")).toBeNull();
    expect(screen.queryByTestId("auth:risk")).toBeNull();
  });

  it("says the credential risk next to an Allow… that lets sign-in travel over http (the package sheet's path)", () => {
    const onAllow = vi.fn();
    render(<MarketplaceProblem testId="auth" subject={ENTRY_SUBJECT} failure={{ code: "SOURCE_AUTH_REQUIRED", message: "", detail: { reason: "token-unencrypted", host: "git.corp.example" } }} onAllow={onAllow} />);
    expect(screen.getByTestId("auth:risk")).toHaveTextContent("git.corp.example 로그인 정보가 암호화되지 않은 채 전송되어 네트워크 경로에 있는 누구나 복사할 수 있습니다. 계속할까요?");
    fireEvent.click(screen.getByTestId("auth:allow"));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it("lists every warning of one confirmation, each as its own sentence", () => {
    render(<MarketplaceProblem tone="warning" testId="problem" text={["First risk.", "Second risk."]} onContinue={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("First risk.")).toBeInTheDocument();
    expect(screen.getByText("Second risk.")).toBeInTheDocument();
  });

  it("says what failed and copies the command it asks for", () => {
    const writeText = clipboard();
    render(
      <MarketplaceProblem
        testId="problem"
        subject={ENTRY_SUBJECT} failure={{ code: "SOURCE_SSH_HOST_UNKNOWN", message: "git ls-remote failed: Host key verification failed.", detail: { reason: "unknown", host: "git.example.com", port: 2222 } }}
      />,
    );

    const problem = screen.getByTestId("problem");
    expect(problem).toHaveAttribute("data-tone", "error");
    expect(problem).toHaveTextContent("이 컴퓨터는 SSH로 git.example.com에 연결한 적이 없어 호스트 키를 확인할 수 없습니다.");
    expect(problem).not.toHaveTextContent("Host key verification failed");
    fireEvent.click(screen.getByRole("button", { name: "명령 복사" }));
    expect(writeText).toHaveBeenCalledWith("ssh-keyscan -p 2222 git.example.com >> ~/.ssh/known_hosts");
  });
  it("refuses an address with a password by its reason, and Copy details never copies the password", () => {
    const writeText = clipboard();
    let refused: MarketplaceError | null = null;
    try {
      normalizeSourceUrl("https://alice:verifier-secret@example.com/owner/repo");
    } catch (error) {
      refused = error as MarketplaceError;
    }
    const answer = parseGitMarketplaceResult({ ok: false, code: refused!.code, message: refused!.message, detail: refused!.detail });
    if (answer === null || answer.ok) throw new Error("expected a failure envelope");
    render(<MarketplaceProblem testId="problem" subject={ENTRY_SUBJECT} failure={answer} />);

    expect(screen.getByTestId("problem")).toHaveTextContent("주소에 비밀번호나 토큰이 있습니다.");
    fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain("SOURCE_URL_REJECTED · credentials-in-url");
    expect(copied).not.toContain("verifier-secret");
  });

  it("scrubs a raw message, and a custom details text, before copying either", () => {
    const writeText = clipboard();
    const raw = [
      "fatal: unable to access 'https://alice:verifier-secret@example.com/owner/repo/': 401",
      "Authorization: Bearer abc123def456ghi789",
      "password=hunter2",
      "pip: git+https://canary-token@github.com/acme/tools",
      'helper failed: token="canarypass"; retry',
      "askpass: secret='canary pass' then",
      "ssh://alice%3Acanary-secret@git.example/acme/tools",
      "scp: alice:canary-scp@github.com:acme/tools",
      "remote ssh://git@git.example/acme/tools",
    ].join("\n");
    const { unmount } = render(<MarketplaceProblem testId="problem" subject={ENTRY_SUBJECT} failure={{ code: "SOURCE_UNREACHABLE", message: raw }} />);
    fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
    unmount();
    render(<MarketplaceProblem testId="problem" subject={ENTRY_SUBJECT} failure={{ code: "NO_INSTALLABLE_ARTIFACT", message: "no rung" }} details={raw} />);
    fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));

    expect(writeText).toHaveBeenCalledTimes(2);
    for (const [copied] of writeText.mock.calls) {
      expect(copied).toContain("example.com/owner/repo");
      expect(copied).toContain("ssh://git@git.example/acme/tools");
      expect(copied).not.toMatch(/verifier-secret|abc123def456ghi789|hunter2|canary/u);
    }
  });

  it.each(DIAGNOSTIC_SECRET_PROBES)("copies the $id spelling scrubbed, from a message, a details override and an error tone's details", ({ text, secret, kept }) => {
    const writeText = clipboard();
    const views = [
      <MarketplaceProblem key="message" subject={ENTRY_SUBJECT} failure={{ code: "SOURCE_UNREACHABLE", message: text }} />,
      <MarketplaceProblem key="override" subject={ENTRY_SUBJECT} failure={{ code: "NO_INSTALLABLE_ARTIFACT", message: "no rung" }} details={text} />,
      <MarketplaceProblem key="error" tone="error" text="서버를 추가하지 못했습니다." details={text} />,
    ];
    for (const view of views) {
      const { unmount } = render(view);
      fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
      unmount();
    }
    expect(writeText).toHaveBeenCalledTimes(3);
    for (const [copied] of writeText.mock.calls) {
      expect(copied).not.toContain(secret);
      if (kept !== undefined) expect(copied).toContain(kept);
    }
  });

  it("renders main's text that once broke the scrubber, without reaching the boundary", () => {
    const writeText = clipboard();
    render(<Boundary><MarketplaceProblem testId="problem" subject={ENTRY_SUBJECT} failure={{ code: "unavailable", message: '{"host":"::1","port":443} {"op":"=","value":3}' }} /></Boundary>);
    expect(screen.queryByTestId("boundary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
    expect(writeText).toHaveBeenCalledWith('unavailable\n{"host":"::1","port":443} {"op":"=","value":3}');
  });

  it("renders when the scrubber fails closed, its text wholly redacted", () => {
    const writeText = clipboard();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const restore = breakDiagnosticScrubberOn("canarysentinel");
    try {
      render(<Boundary><MarketplaceProblem testId="problem" subject={ENTRY_SUBJECT} failure={{ code: "unavailable", message: "helper said token=canarysentinel" }} /></Boundary>);
      expect(screen.queryByTestId("boundary")).toBeNull();
      expect(screen.getByTestId("problem")).not.toHaveTextContent("canarysentinel");
      fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
    } finally {
      restore();
      warn.mockRestore();
    }
    expect(writeText).toHaveBeenCalledWith("[REDACTED:DIAGNOSTIC]");
  });

  it("copies diagnostics that name no credential unchanged", () => {
    const writeText = clipboard();
    render(<MarketplaceProblem tone="error" text="서버를 추가하지 못했습니다." details={DIAGNOSTIC_KEPT.join("\n")} />);
    fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
    expect(writeText).toHaveBeenCalledWith(DIAGNOSTIC_KEPT.join("\n"));
  });

  it("shows a failure outside the marketplace's codes by its own sentence, its raw text only behind Copy details", () => {
    const writeText = clipboard();
    render(<MarketplaceProblem tone="error" testId="problem" text="git 선택을 저장하지 못했습니다." details={"settings-write-failed\nEACCES token=s3cret"} />);

    const problem = screen.getByTestId("problem");
    expect(problem).toHaveAttribute("data-tone", "error");
    expect(problem).toHaveTextContent("git 선택을 저장하지 못했습니다.");
    expect(problem).not.toHaveTextContent("EACCES");
    fireEvent.click(screen.getByRole("button", { name: "세부 정보 복사" }));
    expect(writeText).toHaveBeenCalledWith("settings-write-failed\nEACCES token=[REDACTED:TOKEN]");
  });
});

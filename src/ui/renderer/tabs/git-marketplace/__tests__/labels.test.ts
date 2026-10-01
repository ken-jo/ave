import { describe, expect, it } from "vitest";
import { translate } from "../../../../../i18n/translate.js";
import type { TranslationVars } from "../../../../../i18n/translate.js";
import { MARKETPLACE_ERROR_CODES, MARKETPLACE_ERROR_DETAIL_FIELDS, MARKETPLACE_ERROR_REASONS } from "../../../../../marketplace/errors.js";
import type { GitMarketplaceErrorCode, GitMarketplaceFailure, MarketplaceErrorDetail } from "../../../../../shared/git-marketplace.js";
import type { SourceView } from "../../../../../shared/git-marketplace.js";
import { ENTRY_SUBJECT, OTHER_SUBJECT, failureCommand, failureText, kindLabel, sourceStatusDetail, sourceStatusLabel, sourceSubject, type FailureSubject } from "../labels.js";

describe("package kind display vocabulary", () => {
  it("labels code packages as extensions and entry-free bundles as plugins", () => {
    const codePackage = { kind: "plugin" } as const;
    const bundlePackage = { kind: "agent-plugin" } as const;

    expect(kindLabel((key) => translate("en", key), codePackage.kind)).toBe("Extensions");
    expect(kindLabel((key) => translate("ko", key), codePackage.kind)).toBe("익스텐션");
    expect(kindLabel((key) => translate("en", key), bundlePackage.kind)).toBe("Plugins");
    expect(kindLabel((key) => translate("ko", key), bundlePackage.kind)).toBe("플러그인");
  });
});

const MESSAGE = "main's English message";
const ENVELOPE_CODES: readonly GitMarketplaceErrorCode[] = [...MARKETPLACE_ERROR_CODES, "invalid-request", "unauthorized-frame", "unavailable"];
const UNRESOLVED_PLACEHOLDER = /\{[A-Za-z0-9_]+\}/u;
/** Refusals the plugin install path raises too, so both surfaces read one sentence. */
const SHARED_INSTALL_REFUSAL_KEYS: Readonly<Partial<Record<GitMarketplaceErrorCode, string>>> = {
  "process-entry-unconfined": "formatIpcError.processEntryUnconfined",
  "process-entry-requires-pinned-artifact": "formatIpcError.processEntryRequiresPinnedArtifact",
};

/** The sentence in both catalogs, and the one key it was read from; an address being typed unless `subject` says otherwise. */
function render(failure: GitMarketplaceFailure, subject: FailureSubject = ENTRY_SUBJECT): { key: string; en: string; ko: string } {
  const keys: string[] = [];
  const en = failureText((key: string, vars?: TranslationVars) => {
    // An origin's name read for a sentence's value is not the sentence's key.
    if (!key.startsWith("gitMarketplace.origin.")) keys.push(key);
    return translate("en", key, vars);
  }, failure, subject);
  const ko = failureText((key: string, vars?: TranslationVars) => translate("ko", key, vars), failure, subject);
  expect(keys).toHaveLength(1);
  return { key: keys[0]!, en, ko };
}

/** A detail of `reason` with a recognizable value in every field. */
function sampleDetail(code: keyof typeof MARKETPLACE_ERROR_DETAIL_FIELDS, reason: string): { detail: MarketplaceErrorDetail; values: string[] } {
  const reasons: Readonly<Record<string, Readonly<Record<string, string>>>> = MARKETPLACE_ERROR_DETAIL_FIELDS[code];
  const detail: Record<string, unknown> = { reason };
  const values: string[] = [];
  for (const [field, kind] of Object.entries(reasons[reason]!)) {
    if (kind === "number") {
      detail[field] = 2222;
      values.push("2222");
    } else if (kind === "string[]") {
      detail[field] = ["main", "v1.0.0"];
      values.push("main, v1.0.0");
    } else {
      detail[field] = `${field}-sample`;
      values.push(`${field}-sample`);
    }
  }
  return { detail: detail as MarketplaceErrorDetail, values };
}

describe("failure sentences (design §18.8)", () => {
  it.each(ENVELOPE_CODES)("%s has a reason-less sentence in both catalogs, never CODE · message", (code) => {
    const { key, en, ko } = render({ code, message: MESSAGE });
    const shared = SHARED_INSTALL_REFUSAL_KEYS[code];
    if (shared) expect(key).toBe(shared);
    else expect(key.startsWith("gitMarketplace.")).toBe(true);
    expect(en).not.toBe(key);
    expect(ko).not.toBe(key);
    expect(ko).not.toBe(en);
    expect(en).not.toContain(code);
    expect(en).not.toMatch(UNRESOLVED_PLACEHOLDER);
    // Main's English message is behind Copy details; only `unavailable` has nothing else to say.
    if (code === "unavailable") expect(en).toContain(MESSAGE);
    else expect(en).not.toContain(MESSAGE);
  });

  it("names an unavailable marketplace's message scrubbed, and a policy's unreadable reason too", () => {
    const { en, ko } = render({ code: "unavailable", message: "fetch https://alice:verifier-secret@example.com/x failed; password=hunter2" });
    for (const text of [en, ko]) {
      expect(text).toContain("https://[REDACTED:CREDENTIALS]@example.com/x");
      expect(text).not.toMatch(/verifier-secret|hunter2/u);
    }
    const policy = render({ code: "SOURCE_POLICY_BLOCKED", message: MESSAGE, detail: { reason: "policy-invalid", error: "token=s3cret is not a key" } });
    expect(policy.en).not.toContain("s3cret");
  });

  it("gives every code its own sentence", () => {
    const keys = ENVELOPE_CODES.map((code) => render({ code, message: MESSAGE }).key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(MARKETPLACE_ERROR_REASONS)("%s · %s has its own sentence naming the detail's values", (code, reason) => {
    const { detail, values } = sampleDetail(code as keyof typeof MARKETPLACE_ERROR_DETAIL_FIELDS, reason);
    const reasonless = render({ code, message: MESSAGE }).key;
    const { key, en, ko } = render({ code, message: MESSAGE, detail });
    expect(key).not.toBe(reasonless);
    expect(en).not.toBe(key);
    expect(ko).not.toBe(key);
    expect(en).not.toMatch(UNRESOLVED_PLACEHOLDER);
    expect(ko).not.toMatch(UNRESOLVED_PLACEHOLDER);
    expect(en).not.toContain(MESSAGE);
    for (const value of values) {
      expect(en).toContain(value);
      expect(ko).toContain(value);
    }
  });

  it("gives each reason of a code its own sentence", () => {
    const keys = MARKETPLACE_ERROR_REASONS.map(
      ([code, reason]) => render({ code, message: MESSAGE, detail: sampleDetail(code as keyof typeof MARKETPLACE_ERROR_DETAIL_FIELDS, reason).detail }).key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("renders the reason-less sentence for a detail that does not belong to the code", () => {
    const plain = render({ code: "SOURCE_UNREACHABLE", message: MESSAGE });
    const foreign = render({ code: "SOURCE_UNREACHABLE", message: MESSAGE, detail: { reason: "token", host: "github.com" } });
    expect(foreign).toEqual(plain);
  });

  it("names the ssh command for a host key, on a non-default port too", () => {
    const unknown: GitMarketplaceFailure = { code: "SOURCE_SSH_HOST_UNKNOWN", message: MESSAGE, detail: { reason: "unknown", host: "git.example.com", port: 2222 } };
    const changed: GitMarketplaceFailure = { code: "SOURCE_SSH_HOST_UNKNOWN", message: MESSAGE, detail: { reason: "changed", host: "github.com", port: 22 } };
    expect(failureCommand(unknown)).toBe("ssh-keyscan -p 2222 git.example.com >> ~/.ssh/known_hosts");
    expect(failureCommand(changed)).toBe('ssh-keygen -R "github.com"');
    expect(failureCommand({ ...changed, detail: { reason: "changed", host: "git.example.com", port: 2222 } })).toBe('ssh-keygen -R "[git.example.com]:2222"');
    expect(render(changed).en).toContain('ssh-keygen -R "github.com"');
    expect(failureCommand({ code: "SOURCE_UNREACHABLE", message: MESSAGE })).toBeNull();
  });

  it("lists the branches and tags a missing ref's repository has", () => {
    const { en } = render({
      code: "SOURCE_REF_NOT_FOUND",
      message: MESSAGE,
      detail: { reason: "missing", ref: "nope", repository: "https://github.com/acme/market", available: ["main", "v1.0.0"] },
    });
    expect(en).toBe("nope is not a branch or tag of https://github.com/acme/market. Available: main, v1.0.0. Leave the field empty for the default branch.");
  });
});

// ─── By source kind and token state (§18.8): only actions the user has there ───

type SourceShape = Pick<SourceView, "origin" | "label" | "auth" | "tokenStored">;

const SOURCE_SHAPES: readonly SourceShape[] = (["official", "managed", "custom", "direct"] as const).flatMap((origin) =>
  (["none", "token", "ssh"] as const).flatMap((auth) => [false, true].map((tokenStored) => ({ origin, label: `${origin} label`, auth, tokenStored }))),
);

const SUBJECTS: ReadonlyArray<readonly [string, FailureSubject]> = [
  ["entry", ENTRY_SUBJECT],
  ["other", OTHER_SUBJECT],
  ...SOURCE_SHAPES.map((shape) => [`${shape.origin}/${shape.auth}${shape.tokenStored ? "/stored" : ""}`, sourceSubject(shape)] as const),
];

/** Every failure a sentence can be asked for: each code without a detail, and each reason with one. */
const FAILURES: readonly GitMarketplaceFailure[] = [
  ...ENVELOPE_CODES.map((code) => ({ code, message: MESSAGE })),
  ...MARKETPLACE_ERROR_REASONS.map(([code, reason]) => ({
    code,
    message: MESSAGE,
    detail: sampleDetail(code as keyof typeof MARKETPLACE_ERROR_DETAIL_FIELDS, reason).detail,
  })),
];

const en = (key: string) => translate("en", key);
const ko = (key: string) => translate("ko", key);

/** Advice to change an address, branch or folder: only the user who types it, or added the source, can. */
const FIELD_ADVICE = {
  en: /check the address|check its address|folder field|leave the field empty|check its spelling|field empty/iu,
  ko: /주소(?:와|를|나)[^.]*확인|폴더 칸|칸을 비워|철자를 확인/u,
};

describe("failure sentences by source kind and token state (design §18.8)", () => {
  it("names the official source's Set token… when its host reports no repository and no token is stored", () => {
    const failure: GitMarketplaceFailure = { code: "SOURCE_UNREACHABLE", message: MESSAGE, detail: { reason: "not-found", host: "github.com" } };
    const official = { origin: "official", label: "Ave Official", auth: "token", tokenStored: false } as const;
    const { key, en: english, ko: korean } = render(failure, sourceSubject(official));
    expect(key).toBe("gitMarketplace.error.unreachable.notFound.setToken");
    expect(english).toContain(en("gitMarketplace.sources.setToken"));
    expect(korean).toContain(ko("gitMarketplace.sources.setToken"));
    expect(english).toContain("github.com");
    // A private repository is a possibility, never a claim.
    expect(english).not.toMatch(/\bis private\b/u);
    for (const text of [english, korean]) expect(text).not.toMatch(FIELD_ADVICE.en);
    expect(korean).not.toMatch(FIELD_ADVICE.ko);
  });

  it("says a stored token may lack access when the host still reports no repository", () => {
    const failure: GitMarketplaceFailure = { code: "SOURCE_UNREACHABLE", message: MESSAGE, detail: { reason: "not-found", host: "github.com" } };
    const stored = render(failure, sourceSubject({ origin: "official", label: "official label", auth: "token", tokenStored: true }));
    const noAccess = render({ code: "SOURCE_AUTH_REQUIRED", message: MESSAGE, detail: { reason: "token-no-access", host: "github.com" } }, sourceSubject({ origin: "official", label: "official label", auth: "token", tokenStored: true }));
    for (const sentence of [stored, noAccess]) {
      expect(sentence.key).toBe("gitMarketplace.error.authRequired.tokenNoAccess");
      expect(sentence.en).toMatch(/may lack access/u);
      expect(sentence.en).toContain(en("gitMarketplace.sources.setToken"));
      expect(sentence.ko).toContain(ko("gitMarketplace.sources.setToken"));
    }
  });

  it("renders the Sources row's sentence from the row's own source", () => {
    const row = {
      origin: "official",
      auth: "token",
      tokenStored: false,
      status: { state: "unreachable", code: "SOURCE_UNREACHABLE", detail: { reason: "not-found", host: "github.com" }, cached: false },
    } as SourceView;
    const text = sourceStatusDetail((key: string, vars?: TranslationVars) => translate("en", key, vars), row)!;
    expect(text).toBe(translate("en", "gitMarketplace.error.unreachable.notFound.setToken", { host: "github.com" }));
    expect(text).not.toBe(translate("en", "gitMarketplace.error.notAMarketplace"));
  });

  it.each(SUBJECTS)("%s: every sentence offers only actions that subject has, in both catalogs", (_label, subject) => {
    const shape = subject.kind === "source" ? subject.source : null;
    const canEditFields = subject.kind === "entry" || shape?.origin === "custom" || shape?.origin === "direct";
    const canRemove = shape?.origin === "custom" || shape?.origin === "direct";
    const setToken = { en: en("gitMarketplace.sources.setToken"), ko: ko("gitMarketplace.sources.setToken") };
    const remove = { en: en("gitMarketplace.sources.remove"), ko: ko("gitMarketplace.sources.remove") };
    for (const failure of FAILURES) {
      const sentence = render(failure, subject);
      const where = `${failure.code}${failure.detail ? ` · ${failure.detail.reason}` : ""}`;
      if (!canEditFields) {
        expect(sentence.en, where).not.toMatch(FIELD_ADVICE.en);
        expect(sentence.ko, where).not.toMatch(FIELD_ADVICE.ko);
      }
      // Remove source exists on a row the user added; Set token… on a token source's row.
      if (!canRemove) {
        expect(sentence.en, where).not.toContain(remove.en);
        expect(sentence.ko, where).not.toContain(remove.ko);
      }
      // A token sentence only follows a token Ave offered (token-no-access), so it is the one exception.
      const offeredToken = failure.code === "SOURCE_AUTH_REQUIRED" && failure.detail?.reason === "token-no-access";
      if (shape && shape.auth !== "token" && !offeredToken) {
        expect(sentence.en, where).not.toContain(setToken.en);
        expect(sentence.ko, where).not.toContain(setToken.ko);
      }
      if (subject.kind === "entry") {
        expect(sentence.en, where).not.toContain(setToken.en);
        expect(sentence.en, where).not.toContain(remove.en);
      }
    }
  });

  it("keeps a source the user added on its address advice where it is true", () => {
    const custom = sourceSubject({ origin: "custom", label: "custom label", auth: "none", tokenStored: false });
    const { en: english } = render({ code: "SOURCE_UNREACHABLE", message: MESSAGE, detail: { reason: "not-found", host: "git.example.com" } }, custom);
    expect(english).toContain(en("gitMarketplace.sources.remove"));
    expect(english).toMatch(/Access token/u);
    const typed = render({ code: "SOURCE_NOT_A_MARKETPLACE", message: MESSAGE });
    expect(typed.en).toMatch(/folder field/u);
  });

  it("names the unreadable list of added sources relative to the Ave data folder, and what deleting it costs", () => {
    for (const failure of [
      { code: "SOURCE_LIST_UNREADABLE", message: MESSAGE },
      { code: "SOURCE_LIST_UNREADABLE", message: MESSAGE, detail: { reason: "unreadable", fsCode: "EACCES" } },
      { code: "SOURCE_LIST_UNREADABLE", message: MESSAGE, detail: { reason: "invalid" } },
    ] as const) {
      const { key, en: english, ko: korean } = render(failure, OTHER_SUBJECT);
      expect(key.startsWith("gitMarketplace.error.listUnreadable")).toBe(true);
      for (const text of [english, korean]) {
        expect(text).toContain("marketplaces/sources.json");
        expect(text).not.toMatch(/\/Users\/|~\/|\.ave|[A-Z]:\\/u);
      }
      expect(english).toContain("Ave data folder");
      expect(english).toContain("Deleting it removes only the sources you added");
      expect(korean).toContain("Ave 데이터 폴더");
      expect(korean).toContain("직접 추가한 소스만 사라지고");
      if (failure.detail?.reason === "unreadable") expect(english).toContain("(EACCES)");
    }
  });

  it("has every sentence key it can read in both catalogs, translated", () => {
    const keys = new Set<string>();
    for (const [, subject] of SUBJECTS) {
      for (const failure of FAILURES) {
        failureText((key: string) => {
          keys.add(key);
          return key;
        }, failure, subject);
      }
    }
    expect(keys.size).toBeGreaterThan(ENVELOPE_CODES.length);
    // `translate` falls back from Korean to English and from English to the key, so a missing entry shows as either.
    for (const key of keys) {
      expect(en(key), key).not.toBe(key);
      expect(ko(key), key).not.toBe(en(key));
    }
  });
});

describe("a failed source's status chip names what failed (§15.4)", () => {
  const chip = (locale: "en" | "ko", code: (typeof MARKETPLACE_ERROR_CODES)[number], cached: boolean, detail?: MarketplaceErrorDetail) =>
    sourceStatusLabel((key: string, vars?: TranslationVars) => translate(locale, key, vars), { state: "unreachable", code, ...(detail ? { detail } : {}), cached });

  it.each([
    ["SOURCE_UNREACHABLE", { reason: "dns", host: "github.com" }, "Unreachable", "연결할 수 없음"],
    ["SOURCE_UNREACHABLE", undefined, "Unreachable", "연결할 수 없음"],
    ["SOURCE_UNREACHABLE", { reason: "not-found", host: "github.com" }, "Repository not found", "저장소를 찾을 수 없음"],
    ["SOURCE_UNREACHABLE", { reason: "not-found-ssh", host: "github.com" }, "Repository not found", "저장소를 찾을 수 없음"],
    ["SOURCE_NOT_A_MARKETPLACE", undefined, "No marketplace found", "마켓플레이스를 찾을 수 없음"],
    ["SOURCE_REF_NOT_FOUND", undefined, "Branch or tag not found", "브랜치나 태그 없음"],
    ["SOURCE_INDEX_INVALID", undefined, "Marketplace index invalid", "마켓플레이스 색인 오류"],
    ["SOURCE_SSH_HOST_UNKNOWN", undefined, "SSH host key not verified", "SSH 호스트 키 확인 필요"],
    ["SOURCE_POLICY_BLOCKED", undefined, "Blocked by policy", "정책으로 차단됨"],
    ["SOURCE_URL_REJECTED", undefined, "Address refused", "주소 거부됨"],
    ["GIT_RUNTIME_MISSING", undefined, "Git unavailable", "git 사용 불가"],
    ["PLAN_EXPIRED", undefined, "Update failed", "업데이트 실패"],
  ] as const)("%s %j reads %s, and says when the cached copy is shown", (code, detail, english, korean) => {
    expect(chip("en", code, false, detail)).toBe(english);
    expect(chip("ko", code, false, detail)).toBe(korean);
    expect(chip("en", code, true, detail)).toBe(`${english} — showing cached`);
    expect(chip("ko", code, true, detail)).toBe(`${korean} — 캐시 표시 중`);
  });

  it.each(MARKETPLACE_ERROR_CODES)("%s has a translated chip that says Unreachable only for an unreached host", (code) => {
    const english = chip("en", code, false);
    const korean = chip("ko", code, false);
    expect(english).not.toMatch(/^gitMarketplace\./u);
    expect(korean).not.toBe(english);
    if (code !== "SOURCE_UNREACHABLE") {
      expect(english).not.toContain("Unreachable");
      expect(korean).not.toContain("연결할 수 없음");
    }
  });
});

describe("a damaged copy's sentence says what Repair trusts (§18.8)", () => {
  const PIN_LOST = ["state-missing", "state-invalid", "state-unreadable"] as const;
  const PIN_KEPT = ["snapshot-invalid", "snapshot-unreadable", "repository-damaged"] as const;
  const damaged = (reason: string) => render({ code: "SOURCE_LOCAL_DATA_DAMAGED", message: MESSAGE, detail: { reason, sourceId: "ave" } as MarketplaceErrorDetail });

  it.each(PIN_LOST)("%s warns that Repair trusts the version served now, unchecked, and still offers it", (reason) => {
    const { en: english, ko: korean } = damaged(reason);
    expect(english).toContain("trusts the version the source serves now, without checking it against the one you had");
    expect(korean).toContain("이전 버전과 대조하지 않은 채 지금 제공되는 버전을 신뢰합니다");
    expect(english).toMatch(/choose Repair/u);
    expect(korean).toContain("복구를 누르세요");
  });

  it.each(PIN_KEPT)("%s keeps the pin and says so, without the warning", (reason) => {
    const { en: english, ko: korean } = damaged(reason);
    expect(english).not.toContain("without checking");
    expect(korean).not.toContain("대조하지 않은");
    expect(english).toMatch(/choose Repair to download it again/u);
    if (reason !== "snapshot-invalid") expect(english).toContain("the version Ave trusts is kept");
  });

  it("tells a failed write of the kept pin from a failed move", () => {
    const write = damaged("repair-write-failed");
    const move = damaged("repair-failed");
    expect(write.key).not.toBe(move.key);
    expect(write.en).toMatch(/could not save .* record of the version it trusts, so the source was not downloaded again/u);
    expect(move.en).toMatch(/could not move the damaged copy .* aside/u);
    // Only a move that had a pin to keep says it was kept.
    const unpinned = damaged("repair-failed-unpinned");
    expect(move.en).toContain("the version Ave trusts is kept");
    expect(move.ko).toContain("Ave가 신뢰하는 버전은 유지됩니다");
    expect(unpinned.en).not.toContain("is kept");
    expect(unpinned.ko).not.toContain("유지됩니다");
    expect(write.en).not.toMatch(/changed nothing/u);
  });

  it("names the access token Ave sent, typed or stored, when an address being typed is not found to it", () => {
    const { en: english, ko: korean } = render({ code: "SOURCE_AUTH_REQUIRED", message: MESSAGE, detail: { reason: "token-no-access", host: "github.com" } });
    expect(english).toContain("the access token Ave sent (the one you entered, or the one already stored for github.com)");
    expect(english).not.toMatch(/to the token you entered/u);
    expect(korean).toContain("Ave가 보낸 액세스 토큰(입력한 토큰, 또는 github.com에 이미 저장된 토큰)");
  });
});

describe("a damaged copy's sentence names the source as its row does", () => {
  const failure: GitMarketplaceFailure = { code: "SOURCE_LOCAL_DATA_DAMAGED", message: MESSAGE, detail: { reason: "snapshot-invalid", sourceId: "ave" } };

  it("calls the official source by its origin's name, another source by its label, and an unlisted one by its id", () => {
    const official = render(failure, sourceSubject({ origin: "official", label: "ave", auth: "token", tokenStored: false }));
    expect(official.en).toContain("the Ave Official source");
    expect(official.ko).toContain("Ave 공식 소스의");
    expect(official.en).not.toMatch(/\bave\b/u);
    const custom = render({ ...failure, detail: { reason: "snapshot-invalid", sourceId: "team" } }, sourceSubject({ origin: "custom", label: "Team tools", auth: "none", tokenStored: false }));
    expect(custom.en).toContain("the Team tools source");
    expect(render(failure, OTHER_SUBJECT).en).toContain("the ave source");
  });
});

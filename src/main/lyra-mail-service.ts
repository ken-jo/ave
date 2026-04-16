/**
 * LyraMailService — Microsoft Graph OAuth 토큰 중앙 관리 서비스
 *
 * 이메일·캘린더 등 LYRA Mail를 쓰는 모든 플러그인이 하나의 토큰을 공유.
 * MSAL PublicClientApplication을 싱글톤으로 유지하고
 * ~/.ave/lyra-mail-token.json 에 토큰을 영속화.
 */

import { PublicClientApplication } from "@azure/msal-node";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const AUTHORITY = "https://login.microsoftonline.com/common";

/** 앱 전체에서 공유하는 LYRA Mail 스코프 */
export const LYRA_MAIL_SCOPES = [
  "Mail.Read",
  "Mail.Send",
  "User.Read",
  "Calendars.ReadWrite",
  "offline_access",
];

interface SavedToken {
  accessToken: string;
  expiry: string;
  account: string;
}

type AuthChangeHandler = () => void;

export class LyraMailService {
  private readonly tokenPath: string;
  private readonly pca: PublicClientApplication;

  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private accountName: string | null = null;
  private authInProgress: Promise<void> | null = null;
  private changeHandlers: AuthChangeHandler[] = [];

  constructor(aveRoot: string) {
    this.tokenPath = resolve(aveRoot, "lyra-mail-token.json");
    this.pca = new PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    });
  }

  /** 앱 시작 시 저장된 토큰 로드 */
  async loadSavedToken(): Promise<void> {
    try {
      const raw = await readFile(this.tokenPath, "utf-8");
      const saved = JSON.parse(raw) as SavedToken;
      const expiry = new Date(saved.expiry);
      if (saved.accessToken && expiry > new Date()) {
        this.accessToken = saved.accessToken;
        this.tokenExpiry = expiry;
        this.accountName = saved.account;
        console.log(`[lyra-mail] 저장된 토큰 로드 — ${this.accountName}`);
      }
    } catch {
      // 없으면 무시
    }
  }

  isAuthenticated(): boolean {
    return !!this.accessToken && !!this.tokenExpiry && this.tokenExpiry > new Date();
  }

  getAccountName(): string | null {
    return this.accountName;
  }

  /** 현재 유효한 액세스 토큰 반환. 없으면 null */
  async getAccessToken(): Promise<string | null> {
    if (this.isAuthenticated()) return this.accessToken;
    return null;
  }

  /** 브라우저 기반 인터랙티브 인증 시작 */
  async startInteractiveAuth(openBrowser: (url: string) => Promise<void>): Promise<void> {
    if (this.authInProgress) return this.authInProgress;

    this.authInProgress = this.pca
      .acquireTokenInteractive({
        scopes: LYRA_MAIL_SCOPES,
        openBrowser,
        successTemplate: `
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#60a5fa">인증 완료!</h2>
            <p>이 창을 닫고 앱으로 돌아가세요.</p>
          </body></html>`,
        errorTemplate: `
          <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0b1222;color:#e2e8f0">
            <h2 style="color:#f87171">인증 실패</h2>
            <p>다시 시도해주세요.</p>
          </body></html>`,
      })
      .then(async (result: { accessToken: string; expiresOn: Date | null; account?: { username?: string; name?: string } | null } | null) => {
        if (result) {
          const account = result.account?.username ?? result.account?.name ?? "Unknown";
          await this.persistToken(result.accessToken, result.expiresOn ?? new Date(), account);
          this.notifyChange();
        }
      })
      .finally(() => {
        this.authInProgress = null;
      })
      .then(() => {});

    return this.authInProgress!;
  }

  /** 인증 상태 변경 구독 */
  onAuthChange(handler: AuthChangeHandler): void {
    this.changeHandlers.push(handler);
  }

  private async persistToken(token: string, expiry: Date, account: string): Promise<void> {
    this.accessToken = token;
    this.tokenExpiry = expiry;
    this.accountName = account;
    await mkdir(dirname(this.tokenPath), { recursive: true });
    await writeFile(
      this.tokenPath,
      JSON.stringify({ accessToken: token, expiry: expiry.toISOString(), account }, null, 2),
    );
    console.log(`[lyra-mail] 토큰 저장 완료 — ${account}`);
  }

  private notifyChange(): void {
    for (const h of this.changeHandlers) {
      try { h(); } catch { /* ignore */ }
    }
  }
}

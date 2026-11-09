export type BrowserChallengeVendor = "cloudflare" | "datadome" | "perimeterx" | "akamai";

/** A page observation, never an authorization or an instruction to automate the verification. */
export interface BrowserChallenge {
  readonly vendor: BrowserChallengeVendor;
  readonly hint: "The user can solve it in the web panel.";
}

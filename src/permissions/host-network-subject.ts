import type { ScopedRuleSubject } from "./rules/scoped-rule-matcher.js";

type HostNetworkSubject = Extract<ScopedRuleSubject, { kind: "webfetch" }>;
const issuedSubjects = new WeakSet<HostNetworkSubject>();

/** Bind actual network effects to host-observed destinations without changing their source. */
export function issueHostNetworkSubject(input: { url: string; privateNetwork?: boolean }): HostNetworkSubject {
  const { url, privateNetwork } = input;
  if (typeof url !== "string" || (privateNetwork !== undefined && typeof privateNetwork !== "boolean")) {
    throw new Error("Host network subject has invalid destination evidence");
  }
  const subject: HostNetworkSubject = Object.freeze({ kind: "webfetch", url,
    ...(privateNetwork === undefined ? {} : { privateNetwork }) });
  issuedSubjects.add(subject);
  return subject;
}

export function isHostNetworkSubject(value: unknown): value is HostNetworkSubject {
  return typeof value === "object" && value !== null && issuedSubjects.has(value as HostNetworkSubject);
}

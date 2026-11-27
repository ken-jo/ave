// Each helper runs one table against the in-tree module and the installed runtime's helper; a few literals pin the expected values.
import { BlockList } from "node:net";
import os from "node:os";
import type { ParentProxyRoute, ParentProxyRouter } from "@anthropic-ai/sandbox-runtime";
import * as runtimeAddress from "@anthropic-ai/sandbox-runtime/dist/sandbox/address.js";
import * as runtimePattern from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import * as runtimeHost from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import * as runtimePath from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { egressDestinationNetwork } from "../egress-grants.js";
import * as address from "../egress-relay/address-set.js";
import { isLoopbackAddress } from "../egress-relay/address-set.js";
import {
  canonicalRelayHost, formatAuthority, isReservedAddress, isThisHostAddress, isValidRelayHost, resolvedAddressPermitted,
} from "../egress-relay/destination.js";
import { matchesDomainPatternWithPort } from "../egress-relay/domain-pattern.js";
import type { EgressRelayRoute, EgressRelayRouter } from "../egress-relay/relay.js";
import * as spelling from "../sandbox-path-spelling.js";

const ADDRESSES = [
  "127.0.0.1", "127.255.255.254", "128.0.0.1", "126.255.255.255", "0.0.0.0", "10.1.2.3", "169.254.169.254", "192.168.0.1", "8.8.8.8", "255.255.255.255",
  "::1", "::", "::2", "0:0:0:0:0:0:0:1", "::1%lo0", "127.0.0.1%eth0", "fe80::1", "fe80::1%eth0", "fc00::1", "fd00:ec2::254", "ff02::1", "2001:db8::1",
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:10.0.0.1", "::ffff:8.8.8.8", "::ffff:0:127.0.0.1", "::127.0.0.1", "::0.0.0.2",
  "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::7f00:1", "2002:7f00:1::", "2002:a00:1::1", "2001:0db8:0000:0000:0000:ff00:0042:8329", "1:2:3:4:5:6:7:8",
  "[::1]", "localhost", "example.com", "127.1", "1.2.3", "::ffff", "::g", "1:2:3:4:5:6:7:8:9", "", " 127.0.0.1", "127.0.0.1 ", "%", "::1%",
];

const RANGES = [
  "127.0.0.0/8", "::1", "10.0.0.0/8", "10.1.2.3", "10.1.2.3/32", "0.0.0.0/0", "::/0", "fe80::/10", "fc00::/7", "169.254.0.0/16", "2001:db8::/32",
  "::ffff:10.0.0.0/104", "::ffff:10.0.0.0/96", "::ffff:10.0.0.0/95", "::ffff:10.1.2.3", "::FFFF:a00:0/104", "::ffff:0.0.0.0/96",
  "fe80::1%eth0", "fe80::%eth0/10", "10.0.0.0/33", "::/129", "10.0.0.0/", "10.0.0.0/08", "10.0.0.0/8 ", "10.0.0.0/-1", "10.0.0.0/1e1", "10.0.0.0/0008",
  "example.com", "", "/8", "10.0.0/8", "[::1]", "::1/128/1",
];

const HOST_NAMES = [
  "localhost", "LOCALHOST", "localhost.", "LocalHost.", "a.localhost", "A.B.LOCALHOST.", ".localhost", "localhost..", "notlocalhost", "localhost.example.com",
  "localhostx", "", ".", "127.0.0.1", "::1",
];

const HOSTS = [
  "example.com", "EXAMPLE.com", "Example.COM.", "example.com..", "sub.Example.com", "_dmarc.example.com", "a-b.example.com", "xn--bcher-kva.example", "bücher.example",
  "BÜCHER.example", "例え.jp", "localhost", "LOCALHOST.", "127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "1.2.3.4.", "256.1.1.1", "1.2.3.4.5",
  "::1", "[::1]", "0:0:0:0:0:0:0:1", "[0:0:0:0:0:0:0:1]", "::ffff:1.2.3.4", "[::FFFF:1.2.3.4]", "::ffff:102:304", "2001:DB8::1", "fe80::1%eth0", "[fe80::1%25eth0]",
  "::ffff:1.2.3.4%x.example.com", "[::1", "::1]", "[]", "", " ", "a b", "a\r\nb", "a\u0000b", "a/b", "a?b", "a#b", "a@b", "user:pw@example.com", "example.com:80",
  "%41.example", "*.example.com", "*", "a".repeat(255), "a".repeat(256), `${"a".repeat(63)}.example`, "..", ".", "-", "_",
];

const AUTHORITIES: Array<[string, number, number]> = [
  ["example.com", 80, 80], ["example.com", 8080, 80], ["example.com", 443, 443], ["example.com", 80, 443], ["::1", 443, 443], ["::1", 8443, 443],
  ["2001:db8::1", 80, 80], ["[::1]", 80, 443], ["127.0.0.1", 3128, 80], ["", 0, 0], ["fe80::1%eth0", 1, 2],
];

const PATTERN_HOSTS = [
  "example.com", "EXAMPLE.COM", "api.example.com", "a.b.Example.com", "badexample.com", "example.com.", "example.org", "localhost", "127.0.0.1", "1.2.3.4",
  "::1", "[::1]", "::ffff:1.2.3.4", "2001:db8::1", "[2001:db8::1]", "1.2.3.4.example.com", "::ffff:1.2.3.4%x.example.com", "xn--bcher-kva.example", "",
];
const PATTERN_PORTS = [80, 443, 8443, 22, 65535, 0];
const PATTERNS = [
  "example.com", "Example.Com", "*.example.com", "*.EXAMPLE.com", "*", "*.", "*.com", "*example.com", "example.com:443", "example.com:0443", "example.com:0",
  "example.com:65535", "example.com:65536", "example.com:", "example.com:https", "*.example.com:8443", "*:22", "*:80", "localhost", "localhost:80",
  "127.0.0.1", "127.0.0.1:80", "1.2.3.4:443", "::1", "[::1]", "[::1]:443", "[::1]:x", "[::1]443", "[::1", "0:0:0:0:0:0:0:1", "[0:0:0:0:0:0:0:1]:80",
  "::ffff:1.2.3.4", "[::ffff:1.2.3.4]:443", "2001:DB8::1", "[2001:DB8::1]", "[2001:db8::1%eth0]:80", "fe80::1%eth0", "*.1.2.3.4", "*.4", "*.x.example.com",
  "*.example", "", ":80", "a:b:c",
];

const PATHS = [
  "", "C:\\Users\\alice\\project", "c:\\users\\ALICE", "C:/Users/alice/a.txt", "C:\\Users\\alice\\*.txt", "C:\\Users\\alice\\a?.txt", "C:\\Users\\alice\\[draft].txt",
  "C:\\Users\\alice\\**\\*.ts", "\\\\?\\C:\\Users\\alice", "\\\\?\\c:\\x", "\\\\?\\UNC\\server\\share\\dir", "\\\\?\\unc\\Server\\Share", "\\\\?\\Unc\\s\\s", "\\\\?\\UNCX\\server",
  "\\\\?\\", "\\\\?\\UNC\\", "\\\\.\\UNC\\server\\share", "\\\\.\\pipe\\name", "\\\\server\\share\\dir", "//server/share/dir", "//?/UNC/server/share", "\\\\?\\Volume{0}\\x",
  "\\??\\C:\\x", "\\\\", "\\", "C:", "C:\\", "relative\\path", "..\\up", "%USERPROFILE%\\Documents", "%userprofile%/docs", "%UserProfile%", "%HOMEDRIVE%%HOMEPATH%\\x",
  "%homedrive%\\x", "%HOMEPATH%", "%USERPROFILE%%USERPROFILE%", "%APPDATA%\\x", "%USERPROFILE", "USERPROFILE%", "%%USERPROFILE%%",
  "/home/alice/project", "/home/alice/project/", "/home/alice/*.txt", "/home/alice/**/*.ts", "/home/alice/a?.txt", "/home/alice/[ab].txt", "/home/alice/x]y",
  "/home/alice/dir/*", "/home/alice/dir/**", "/*", "/**", "*", "**/*.ts", "?", "[", "]", "/", "//", "/a", "a", "a/b*", "a/*/b", "./a/*", "~/x/*", "~", "~/x",
  "C:/Users/alice/**", "C:/Users/alice/dir/f*.txt", "C:/*", "C:*", "/home/alice/файл", "/home/alice/a b/c",
];

function both<Args extends unknown[], Out>(ours: (...args: Args) => Out, theirs: (...args: Args) => Out, rows: readonly Args[]): void {
  for (const row of rows) expect({ row, out: ours(...row) }).toEqual({ row, out: theirs(...row) });
}

const one = <T,>(values: readonly T[]): [T][] => values.map((value) => [value]);

describe("address ranges", () => {
  it("names the same loopback ranges", () => {
    expect(address.LOOPBACK_RANGES).toEqual(runtimeAddress.LOOPBACK_RANGES);
    expect(address.LOOPBACK_RANGES).toEqual(["127.0.0.0/8", "::1"]);
  });

  it("finds the same IPv4 address inside an IPv6 literal", () => {
    both(address.embeddedIPv4, runtimeAddress.embeddedIPv4, one(ADDRESSES));
    expect(address.embeddedIPv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(address.embeddedIPv4("::ffff:0:127.0.0.1")).toBe("127.0.0.1");
    expect(address.embeddedIPv4("64:ff9b::7f00:1")).toBe("127.0.0.1");
    expect(address.embeddedIPv4("2002:7f00:1::")).toBe("127.0.0.1");
    expect(address.embeddedIPv4("::1")).toBe("0.0.0.1");
    expect(address.embeddedIPv4("64:ff9b:1::7f00:1")).toBeUndefined();
    expect(address.embeddedIPv4("127.0.0.1")).toBeUndefined();
  });

  it("classifies loopback addresses and names alike", () => {
    // The helper judges a spelling as written; the runtime's drops a zone first, so the two part on a zoned spelling that is not an address.
    const zonedNonAddress = ["127.0.0.1%eth0", "::1%"];
    both(address.isLoopbackAddress, runtimeAddress.isLoopbackAddress, one(ADDRESSES.filter((spelled) => !zonedNonAddress.includes(spelled))));
    expect(zonedNonAddress.map((spelled) => [address.isLoopbackAddress(spelled), runtimeAddress.isLoopbackAddress(spelled)])).toEqual([[false, true], [false, true]]);
    both(address.isLoopbackName, runtimeAddress.isLoopbackName, one([...HOST_NAMES, ...HOSTS]));
    expect(ADDRESSES.filter(address.isLoopbackAddress)).toEqual(["127.0.0.1", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::1%lo0", "::ffff:127.0.0.1", "::ffff:7f00:1"]);
    expect(HOST_NAMES.filter(address.isLoopbackName)).toEqual(["localhost", "LOCALHOST", "localhost.", "LocalHost.", "a.localhost", "A.B.LOCALHOST.", ".localhost"]);
  });

  it("accepts the same range entries and matches the same addresses", () => {
    const accepted: string[] = [];
    for (const range of RANGES) {
      const ours = new BlockList();
      const theirs = new BlockList();
      const added = address.addRange(ours, range);
      expect({ range, added }).toEqual({ range, added: runtimeAddress.addRange(theirs, range) });
      if (added) accepted.push(range);
      for (const probe of ADDRESSES) {
        expect({ range, probe, hit: address.addressInSet(ours, probe) }).toEqual({ range, probe, hit: runtimeAddress.addressInSet(theirs, probe) });
        expect({ range, probe, hit: address.addressInSet(ours, probe) }).toEqual({ range, probe, hit: runtimeAddress.addressInSet(ours, probe) });
      }
    }
    expect(accepted).toEqual([
      "127.0.0.0/8", "::1", "10.0.0.0/8", "10.1.2.3", "10.1.2.3/32", "0.0.0.0/0", "::/0", "fe80::/10", "fc00::/7", "169.254.0.0/16", "2001:db8::/32",
      "::ffff:10.0.0.0/104", "::ffff:10.0.0.0/96", "::ffff:10.1.2.3", "::FFFF:a00:0/104", "::ffff:0.0.0.0/96", "fe80::1%eth0", "fe80::%eth0/10", "10.0.0.0/08",
    ]);
    const mapped = new BlockList();
    expect(address.addRange(mapped, "::ffff:10.0.0.0/104")).toBe(true);
    expect(address.addressInSet(mapped, "10.9.9.9")).toBe(true);
    expect(address.addressInSet(mapped, "11.0.0.1")).toBe(false);
    expect(address.addressInSet(mapped, "not-an-address")).toBe(false);
  });
});

describe("host spelling", () => {
  it("canonicalizes hosts alike", () => {
    both(canonicalRelayHost, runtimeHost.canonicalizeHost, one(HOSTS));
    expect(canonicalRelayHost("Example.COM.")).toBe("example.com");
    expect(canonicalRelayHost("bücher.example")).toBe("xn--bcher-kva.example");
    expect(canonicalRelayHost("2130706433")).toBe("127.0.0.1");
    expect(canonicalRelayHost("[0:0:0:0:0:0:0:1]")).toBe("::1");
    expect(canonicalRelayHost("::FFFF:1.2.3.4")).toBe("1.2.3.4");
    expect(canonicalRelayHost("fe80::1%eth0")).toBeUndefined();
  });

  it("validates hosts alike", () => {
    both(isValidRelayHost, runtimeHost.isValidHost, one(HOSTS));
    expect(isValidRelayHost("_dmarc.example.com")).toBe(true);
    expect(isValidRelayHost("fe80::1%eth0")).toBe(false);
    expect(isValidRelayHost("a\r\nb")).toBe(false);
    expect(isValidRelayHost("a".repeat(256))).toBe(false);
  });

  it("formats authorities alike", () => {
    both(formatAuthority, runtimeHost.formatAuthority, AUTHORITIES);
    expect(formatAuthority("::1", 8443, 443)).toBe("[::1]:8443");
    expect(formatAuthority("example.com", 443, 443)).toBe("example.com");
  });
});

describe("destination patterns", () => {
  it("matches hosts and ports alike", () => {
    const rows = PATTERNS.flatMap((pattern) => PATTERN_HOSTS.flatMap((host) => PATTERN_PORTS.map((port): [string, number, string] => [host, port, pattern])));
    both(matchesDomainPatternWithPort, runtimePattern.matchesDomainPatternWithPort, rows);
    const admits = (host: string, port: number, pattern: string): boolean => matchesDomainPatternWithPort(host, port, pattern);
    expect(admits("API.example.com", 443, "*.Example.com")).toBe(true);
    expect(admits("example.com", 443, "*.example.com")).toBe(false);
    expect(admits("badexample.com", 443, "*.example.com")).toBe(false);
    expect(admits("1.2.3.4", 443, "*.4")).toBe(false);
    expect(admits("example.com", 80, "example.com:443")).toBe(false);
    expect(admits("example.com", 80, "example.com")).toBe(true);
    expect(admits("anything", 22, "*:22")).toBe(true);
    expect(admits("::1", 443, "[0:0:0:0:0:0:0:1]:443")).toBe(true);
    expect(admits("1.2.3.4", 443, "[::ffff:1.2.3.4]:443")).toBe(true);
    expect(admits("example.com", 65536, "example.com:65536")).toBe(false);
  });
});

describe("path spelling", () => {
  // Every expansion check runs under a stubbed home, so the account's own profile spelling never reaches an expectation.
  const withHome = (home: string, check: () => void) => {
    vi.stubEnv(process.platform === "win32" ? "USERPROFILE" : "HOME", home);
    try {
      expect(os.homedir()).toBe(home);
      check();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it("answers alike for every helper", () => withHome("C:\\Users\\alice", () => {
    const rows = one(PATHS);
    both(spelling.normalizeCaseForComparison, runtimePath.normalizeCaseForComparison, rows);
    both(spelling.containsGlobChars, runtimePath.containsGlobChars, rows);
    both(spelling.containsGlobCharsWin, runtimePath.containsGlobCharsWin, rows);
    both(spelling.stripExtendedPathPrefix, runtimePath.stripExtendedPathPrefix, rows);
    both(spelling.isUncPath, runtimePath.isUncPath, rows);
    both(spelling.expandWindowsEnvRefs, runtimePath.expandWindowsEnvRefs, rows);
    both(spelling.globPatternBaseDir, runtimePath.globPatternBaseDir, rows);
    both(spelling.toForwardSlashes, runtimePath.toForwardSlashes, rows);
  }));

  it("pins the expected spellings", () => {
    expect(spelling.normalizeCaseForComparison("C:\\Users\\ALICE")).toBe("c:\\users\\alice");
    expect(PATHS.filter((path) => spelling.containsGlobChars(path) !== spelling.containsGlobCharsWin(path))).toEqual([
      "C:\\Users\\alice\\[draft].txt", "/home/alice/[ab].txt", "/home/alice/x]y", "[", "]",
    ]);
    expect(spelling.stripExtendedPathPrefix("\\\\?\\C:\\Users\\alice")).toBe("C:\\Users\\alice");
    expect(spelling.stripExtendedPathPrefix("\\\\?\\unc\\Server\\Share")).toBe("\\\\Server\\Share");
    expect(spelling.stripExtendedPathPrefix("\\\\.\\pipe\\name")).toBe("\\\\.\\pipe\\name");
    expect(PATHS.filter(spelling.isUncPath)).toEqual([
      "\\\\?\\UNC\\server\\share\\dir", "\\\\?\\unc\\Server\\Share", "\\\\?\\Unc\\s\\s", "\\\\.\\UNC\\server\\share", "\\\\server\\share\\dir",
      "//server/share/dir", "//?/UNC/server/share",
    ]);
    expect(spelling.globPatternBaseDir("/home/alice/dir/*")).toBe("/home/alice/dir");
    expect(spelling.globPatternBaseDir("/home/alice/dir/f*.txt")).toBe("/home/alice/dir");
    expect(spelling.globPatternBaseDir("C:/*")).toBe("C:");
    expect(spelling.globPatternBaseDir("/*")).toBe("");
    expect(spelling.globPatternBaseDir("*")).toBe("");
    expect(spelling.globPatternBaseDir("a*")).toBe(".");
    expect(spelling.toForwardSlashes("C:\\a\\b")).toBe(process.platform === "win32" ? "C:/a/b" : "C:\\a\\b");
    withHome("C:\\Users\\alice", () => {
      expect(spelling.expandWindowsEnvRefs("%userprofile%\\x")).toBe("C:\\Users\\alice\\x");
      expect(spelling.expandWindowsEnvRefs("%HOMEDRIVE%%HOMEPATH%")).toBe("C:\\Users\\alice");
      expect(spelling.expandWindowsEnvRefs("%APPDATA%\\x")).toBe("%APPDATA%\\x");
    });
  });

  it("strips the same extended prefixes", () => {
    both(spelling.stripExtendedPathPrefix, runtimePath.stripExtendedPathPrefix, one([
      "\\\\?\\unc", "\\\\?\\UNC", "\\\\?\\UNC\\\\?\\x", "\\\\?\\\\\\?\\C:\\x", "\\\\?\\UNC\\server", "//?/C:/x", "//?/UNC/server/share", "\\\\.\\C:\\x",
      "\\\\?\\c:\\Users\\ALICE", "\\\\?\\uNc\\Server\\Share\\a", "x\\\\?\\C:\\x", " \\\\?\\C:\\x",
    ]));
    expect(spelling.stripExtendedPathPrefix("\\\\?\\\\\\?\\C:\\x")).toBe("\\\\?\\C:\\x");
    expect(spelling.stripExtendedPathPrefix("\\\\?\\uNc\\Server\\Share\\a")).toBe("\\\\Server\\Share\\a");
  });

  it.each([
    "C:\\Users\\alice", "c:\\users\\bob", "D:\\", "\\\\server\\share\\alice", "/home/alice", "relative",
  ])("expands env refs alike with the home at %s", (home) => withHome(home, () => {
    both(spelling.expandWindowsEnvRefs, runtimePath.expandWindowsEnvRefs, one(PATHS));
  }));

  it.each([
    "C:\\Users\\alice\\a$&b",
    "C:\\Users\\alice\\$1$$data",
  ])("expands env refs literally with the home at %s", (home) => withHome(home, () => {
    expect(spelling.expandWindowsEnvRefs("%USERPROFILE%")).toBe(home);
    expect(spelling.expandWindowsEnvRefs("%HOMEDRIVE%%HOMEPATH%")).toBe(home);
  }));

  it("keeps reference tokens introduced by home expansion literal", () => {
    const home = "C:\\Users\\alice\\a$$b\\%HOMEPATH%";
    withHome(home, () => {
      expect(spelling.expandWindowsEnvRefs("%USERPROFILE%*")).toBe(`${home}*`);
      expect(spelling.expandWindowsEnvRefs("%HOMEDRIVE%%HOMEPATH%*")).toBe(`${home}*`);
    });
  });

  it("leaves the drive empty for a home without one", () => withHome("\\\\server\\share\\alice", () => {
    expect(spelling.expandWindowsEnvRefs("%HOMEDRIVE%|%HOMEPATH%")).toBe("|\\\\server\\share\\alice");
  }));
});

describe("relay resolved-address check", () => {
  const PUBLIC = "93.184.216.34";

  it.each([
    ["LOCALHOST.", PUBLIC],
    ["a.Localhost", PUBLIC],
    ["allowed.example", "::"],
    ["allowed.example", "::1"],
    ["allowed.example", "::ffff:127.0.0.1%eth0"],
  ])("refuses %s at %s", (host, resolved) => {
    expect(resolvedAddressPermitted(host, resolved, 443, [], [])).toBe(false);
  });

  it.each(["127.0.0.1%eth0", "::1%"])("does not take the zoned spelling %s as loopback", (zoned) => {
    expect(isLoopbackAddress(zoned)).toBe(false);
    expect(resolvedAddressPermitted("localhost", zoned, 443, [], [])).toBe(false);
    expect(() => egressDestinationNetwork("allowed.example", [zoned])).toThrow(/is not an IP address/u);
    expect(isValidRelayHost(zoned)).toBe(false);
  });

  it("keeps a named-zone loopback address loopback, and local as a grant class", () => {
    expect(["127.0.0.1", "::1", "::1%lo0", "::ffff:127.0.0.1", "10.0.0.1", "::"].map(isLoopbackAddress)).toEqual([true, true, true, true, false, false]);
    expect(egressDestinationNetwork("allowed.example", ["::1%lo0"])).toBe("local");
  });

  it("keeps the unspecified and loopback addresses in their own classes", () => {
    expect([isReservedAddress("::"), isLoopbackAddress("::")]).toEqual([true, false]);
    expect([isReservedAddress("::1"), isLoopbackAddress("::1")]).toEqual([false, true]);
    expect([isReservedAddress("::1%lo0"), isThisHostAddress("::1%lo0", [])]).toEqual([false, true]);
    expect(isReservedAddress("::ffff:0.0.0.1")).toBe(true);
    expect(isThisHostAddress("::ffff:127.0.0.1%eth0", [])).toBe(true);
    expect(resolvedAddressPermitted("localhost", "::1", 443, [], [])).toBe(true);
    expect(resolvedAddressPermitted("allowed.example", PUBLIC, 443, [], [])).toBe(true);
  });
});

describe("route types", () => {
  it("are interchangeable with the installed runtime's", () => {
    expectTypeOf<EgressRelayRoute>().toEqualTypeOf<ParentProxyRoute>();
    expectTypeOf<EgressRelayRouter>().toEqualTypeOf<ParentProxyRouter>();
  });
});

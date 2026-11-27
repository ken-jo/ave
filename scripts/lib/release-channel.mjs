// Derive update-feed, versioned installer and stable-alias paths from the single publish URL.
// Keep feeds and referenced files under the same prefix.

export const MAC_FEED_FILE = "latest-mac.yml";
export const FEED_FILES = Object.freeze(["latest.yml", MAC_FEED_FILE, "latest-linux.yml"]);
const LATEST_PREFIX = "latest/";
const REQUIRED_SECRETS = Object.freeze(["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]);

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// Feed files and stable aliases change each release and must always revalidate.
export const REVALIDATE_CACHE = "public, no-cache, must-revalidate";

const INSTALLER_TYPES = Object.freeze({
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".AppImage": "application/vnd.appimage",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
});
const BLOCKMAP_TYPE = "application/octet-stream";
const FEED_TYPE = "application/yaml";

function fail(message) {
  throw new Error(`[release-channel] ${message}`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function releaseChannel(packageJson) {
  const publish = packageJson?.build?.publish;
  if (!Array.isArray(publish) || publish.length !== 1) {
    fail("package.json build.publish must be an array with exactly one entry");
  }
  const [entry] = publish;
  if (entry?.provider !== "generic") {
    fail(`package.json build.publish[0].provider must be "generic" (got ${JSON.stringify(entry?.provider)})`);
  }
  if (entry.channel !== "latest") {
    // src/main/auto-updater.ts pins the channel to "latest" at runtime.
    fail(`package.json build.publish[0].channel must be "latest" (got ${JSON.stringify(entry.channel)})`);
  }
  if (entry.useMultipleRangeRequest !== false) {
    fail("package.json build.publish[0].useMultipleRangeRequest must be false: R2 documents single Range requests, and electron-updater otherwise sends multi-range ones");
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    fail(`package.json build.publish[0].url is not a URL (got ${JSON.stringify(entry.url)})`);
  }
  const prefix = url.pathname.replace(/^\//u, "");
  if (
    url.protocol !== "https:" || url.search !== "" || url.hash !== "" || url.username !== "" ||
    url.href !== entry.url || !/^[a-z0-9-]+$/u.test(prefix) || `${prefix}/` === LATEST_PREFIX
  ) {
    fail(
      "package.json build.publish[0].url must be https://<host>/<prefix> with one lowercase path segment, " +
        `no trailing slash, and not "latest" (got ${JSON.stringify(entry.url)})`,
    );
  }
  return Object.freeze({
    feedUrl: entry.url,
    origin: url.origin,
    feedPrefix: `${prefix}/`,
    latestPrefix: LATEST_PREFIX,
  });
}

export function latestDownloadUrl(channel, rest) {
  return `${channel.origin}/${channel.latestPrefix}${rest}`;
}

// Read the updater's fixed feed serialization without adding a general YAML parser.
export function feedReferences(text) {
  const unquote = (value) => value.replace(/^(['"])(.*)\1$/u, "$2");
  const version = /^version:\s*(.+?)\s*$/mu.exec(text)?.[1];
  const files = new Set();
  for (const match of text.matchAll(/^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/gmu)) {
    files.add(unquote(match[1]));
  }
  return { version: version === undefined ? undefined : unquote(version), files: [...files].sort() };
}

function macFeedWithSystemFloor(text, version) {
  // Update eligibility uses the Darwin kernel release. Only major-release
  // floors with a known mapping can be published.
  const major = typeof version === "string" ? /^(1[1-5])\.0$/u.exec(version)?.[1] : undefined;
  if (major === undefined) fail("package.json build.mac.minimumSystemVersion has no Darwin release mapping");

  const fields = text.match(/^minimumSystemVersion:.*$/gmu);
  const field = `minimumSystemVersion: ${Number(major) + 9}.0.0`;
  if (fields === null) return `${text}${text.endsWith("\n") ? "" : "\n"}${field}\n`;
  if (fields.length !== 1 || fields[0].trimEnd() !== field) {
    fail(`${MAC_FEED_FILE} must contain one ${field} field`);
  }
  return text;
}

/**
 * The ordered upload plan.
 *
 * @param {object} input
 * @param {object} input.packageJson  the repository's package.json
 * @param {string} input.tag          the pushed tag, `v<version>`
 * @param {string[]} input.files      file names in the staging directory
 * @param {(name: string) => string} input.readFeed  reads a staged feed file
 * @returns {{ channel: object, version: string, operations: object[], macFeed: string }}
 *
 * Order: versioned installers and blockmaps, then the `latest/` alias copies,
 * then the three feed files. A client that reads a new feed therefore only
 * ever finds files that were uploaded before it.
 */
export function planR2Upload({ packageJson, tag, files, readFeed }) {
  const channel = releaseChannel(packageJson);
  const version = packageJson?.version;
  const productName = packageJson?.build?.productName;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    fail(`package.json version must be X.Y.Z (got ${JSON.stringify(version)})`);
  }
  if (typeof productName !== "string" || productName.length === 0) {
    fail("package.json build.productName is missing");
  }
  if (tag !== `v${version}`) {
    fail(`tag ${JSON.stringify(tag)} does not equal v${version} from package.json`);
  }

  const versioned = new RegExp(`^${escapeRegExp(productName)}-${escapeRegExp(version)}-(.+)$`, "u");
  const installers = [];
  const blockmaps = [];
  const feeds = [];
  for (const name of [...files].sort()) {
    if (FEED_FILES.includes(name)) {
      feeds.push(name);
      continue;
    }
    const isBlockmap = name.endsWith(".blockmap");
    const base = isBlockmap ? name.slice(0, -".blockmap".length) : name;
    const extension = Object.keys(INSTALLER_TYPES).find((ext) => base.endsWith(ext));
    if (extension === undefined) fail(`${name} is not an installer, blockmap or feed file`);
    const rest = versioned.exec(base)?.[1];
    if (rest === undefined) fail(`${name} is not named ${productName}-${version}-<platform>`);
    if (isBlockmap) blockmaps.push(name);
    else installers.push({ name, rest, contentType: INSTALLER_TYPES[extension] });
  }

  const installerNames = new Set(installers.map(({ name }) => name));
  for (const name of blockmaps) {
    if (!installerNames.has(name.slice(0, -".blockmap".length))) fail(`${name} has no installer beside it`);
  }
  const missingFeeds = FEED_FILES.filter((name) => !feeds.includes(name));
  if (missingFeeds.length > 0) fail(`staging is missing ${missingFeeds.join(", ")}`);
  const macFeed = macFeedWithSystemFloor(readFeed(MAC_FEED_FILE), packageJson.build.mac?.minimumSystemVersion);
  for (const name of FEED_FILES) {
    const { version: feedVersion, files: referenced } = feedReferences(name === MAC_FEED_FILE ? macFeed : readFeed(name));
    if (feedVersion !== version) fail(`${name} is for version ${JSON.stringify(feedVersion)}, not ${version}`);
    if (referenced.length === 0) fail(`${name} names no files`);
    const absent = referenced.filter((file) => !installerNames.has(file));
    if (absent.length > 0) fail(`${name} names files that are not staged: ${absent.join(", ")}`);
  }

  const operations = [];
  for (const { name, contentType } of installers) {
    operations.push({ action: "put", source: name, key: `${channel.feedPrefix}${name}`, contentType, cacheControl: IMMUTABLE_CACHE, immutable: true });
  }
  for (const name of blockmaps) {
    operations.push({ action: "put", source: name, key: `${channel.feedPrefix}${name}`, contentType: BLOCKMAP_TYPE, cacheControl: IMMUTABLE_CACHE, immutable: true });
  }
  for (const { name, rest, contentType } of installers) {
    operations.push({
      action: "copy",
      from: `${channel.feedPrefix}${name}`,
      key: `${channel.latestPrefix}${rest}`,
      contentType,
      cacheControl: REVALIDATE_CACHE,
      contentDisposition: `attachment; filename="${name}"`,
    });
  }
  for (const name of FEED_FILES) {
    operations.push({ action: "put", source: name, key: `${channel.feedPrefix}${name}`, contentType: FEED_TYPE, cacheControl: REVALIDATE_CACHE, immutable: false });
  }
  return { channel, version, operations, macFeed };
}

// Empty secrets count as missing.
export function missingSecrets(env) {
  return REQUIRED_SECRETS.filter((name) => typeof env[name] !== "string" || env[name].trim().length === 0);
}

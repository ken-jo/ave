/**
 * The R2 release channel: where installed apps update from and where the
 * website's download buttons point.
 *
 * `package.json` `build.publish` holds exactly one `generic` entry. That entry
 * is what electron-builder embeds as the packaged `app-update.yml`, and its
 * URL is the one source for everything below:
 *
 *   <origin>/<feed prefix>/latest.yml, latest-mac.yml, latest-linux.yml
 *       the update feed. electron-updater requests `<url>/<channel>.yml` and
 *       resolves each `url:` inside it against the same base, so the feed and
 *       the files it names live under one prefix.
 *   <origin>/<feed prefix>/<Product>-<version>-<rest>
 *       versioned installers and their `.blockmap` sidecars. The version in
 *       the name keeps every release, and electron-updater finds the previous
 *       version's blockmap by replacing the version in the new file's URL.
 *   <origin>/latest/<rest>
 *       stable download aliases for the website, server-side copies of the
 *       versioned installers that carry the versioned name as their download
 *       filename.
 *
 * `planR2Upload` turns a staging directory listing into the ordered upload
 * plan; `scripts/upload-release-r2.mjs` executes it.
 */

export const FEED_FILES = Object.freeze(["latest.yml", "latest-mac.yml", "latest-linux.yml"]);
const LATEST_PREFIX = "latest/";
const REQUIRED_SECRETS = Object.freeze(["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]);

/** Versioned objects never change once uploaded. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** The feed and the `latest/` aliases change every release: always revalidate. */
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

/** The single `generic` publish entry, held to the shape the updater needs. */
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
    fail("package.json build.publish[0].useMultipleRangeRequest must be false: R2 serves single byte ranges");
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

/** The public URL of the stable alias for a versioned installer suffix. */
export function latestDownloadUrl(channel, rest) {
  return `${channel.origin}/${channel.latestPrefix}${rest}`;
}

/**
 * The file names and version an electron-builder `latest*.yml` names. The
 * format is electron-builder's own fixed serialization, so this reads the
 * `version:`, `url:` and `path:` keys line by line instead of pulling a YAML
 * parser into the publishing job.
 */
export function feedReferences(text) {
  const unquote = (value) => value.replace(/^(['"])(.*)\1$/u, "$2");
  const version = /^version:\s*(.+?)\s*$/mu.exec(text)?.[1];
  const files = new Set();
  for (const match of text.matchAll(/^\s*(?:-\s+)?(?:url|path):\s*(.+?)\s*$/gmu)) {
    files.add(unquote(match[1]));
  }
  return { version: version === undefined ? undefined : unquote(version), files: [...files].sort() };
}

/**
 * The ordered upload plan.
 *
 * @param {object} input
 * @param {object} input.packageJson  the repository's package.json
 * @param {string} input.tag          the pushed tag, `v<version>`
 * @param {string[]} input.files      file names in the staging directory
 * @param {(name: string) => string} input.readFeed  reads a staged feed file
 * @returns {{ channel: object, version: string, operations: object[] }}
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
  for (const name of FEED_FILES) {
    const { version: feedVersion, files: referenced } = feedReferences(readFeed(name));
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
  return { channel, version, operations };
}

/** Names of required secrets that are unset or empty. GitHub passes a secret
 *  that does not exist as an empty string, so empty counts as missing. */
export function missingSecrets(env) {
  return REQUIRED_SECRETS.filter((name) => typeof env[name] !== "string" || env[name].trim().length === 0);
}

import { DOCUMENT_ENGINE_IMPORTER } from "../shared/document-engine-importer.js";

export interface DocumentEngineRelease {
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly version: string;
  readonly filename: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly installedBytes: number;
}

const RELEASE_VERSION = "26.8.1";
const DOWNLOAD_ORIGIN = "https://download.documentfoundation.org";

const RELEASES: readonly DocumentEngineRelease[] = Object.freeze([
  { platform: "darwin", arch: "arm64", version: RELEASE_VERSION, filename: "LibreOffice_26.8.1_MacOS_aarch64.dmg",
    url: `${DOWNLOAD_ORIGIN}/libreoffice/stable/26.8.1/mac/aarch64/LibreOffice_26.8.1_MacOS_aarch64.dmg?mirrorlist=0`,
    bytes: 298_845_477, sha256: "ca074e0b13571efb30a31fc531c5f95e997030637325e5d5de92d67aefdf0dfc", installedBytes: 1_800_000_000 },
  { platform: "darwin", arch: "x64", version: RELEASE_VERSION, filename: "LibreOffice_26.8.1_MacOS_x86-64.dmg",
    url: `${DOWNLOAD_ORIGIN}/libreoffice/stable/26.8.1/mac/x86_64/LibreOffice_26.8.1_MacOS_x86-64.dmg?mirrorlist=0`,
    bytes: 309_092_706, sha256: "4c7464313a529e9074400cbcdc894fc40ac4ef9421ded03b16b5a78d12cb155e", installedBytes: 1_800_000_000 },
  { platform: "win32", arch: "x64", version: RELEASE_VERSION, filename: "LibreOffice_26.8.1_Win_x86-64.msi",
    url: `${DOWNLOAD_ORIGIN}/libreoffice/stable/26.8.1/win/x86_64/LibreOffice_26.8.1_Win_x86-64.msi?mirrorlist=0`,
    bytes: 374_870_016, sha256: "c6298b10cfa1748bcbedad94c62ce771e240e5021bfd6d7a967cd571b04b5312", installedBytes: 2_000_000_000 },
  { platform: "win32", arch: "arm64", version: RELEASE_VERSION, filename: "LibreOffice_26.8.1_Win_aarch64.msi",
    url: `${DOWNLOAD_ORIGIN}/libreoffice/stable/26.8.1/win/aarch64/LibreOffice_26.8.1_Win_aarch64.msi?mirrorlist=0`,
    bytes: 360_910_848, sha256: "97c2173752325af1da3d8731f41c8e09a7c4ad491cf55d9b1069fadb5668e6d7", installedBytes: 2_000_000_000 },
  { platform: "linux", arch: "x64", version: RELEASE_VERSION, filename: "LibreOffice_26.8.1_Linux_x86-64_deb.tar.gz",
    url: `${DOWNLOAD_ORIGIN}/libreoffice/stable/26.8.1/deb/x86_64/LibreOffice_26.8.1_Linux_x86-64_deb.tar.gz?mirrorlist=0`,
    bytes: 219_791_834, sha256: "30903df3b9f61360d9660cd707de48cd2831469114492a5008ed58a0ac77d044", installedBytes: 1_500_000_000 },
]);

export const DOCUMENT_ENGINE_RELEASE_KEY = Object.freeze({
  fingerprint: "C2839ECAD9408FBE9531C3E9F434A1EFAFEEAEA3",
  packet: "BEyzEr0BEADT441wUITsTwDA2nM3kmUhGrzTdxZB5xv/E1ZJCw63qWdmdTdWNZDfNDuLs4r2VjlEoA3xGK6jgnQvyAoNj0yiEbW/JedHHgOiVdXDlkgkY58myafTFXqDLzTXVrsNnay0GS8XrNjptZJPhEPBvNUdkqpA9B7RTkfaXj779Pf/AeFMZVLlUAci5RA0NNF910GHwoXT6SEv2PGoawsphnfmMVdKh9wz7asbtKXEmotCwX3k045xLsIVK5ANOi+BI9C3LkrrFJWw2XHqDW2ulwCJ0L5QNSjOuY/v8REODwIXamvvdZOzXBKSIzDOalJqFCHls3YlGyFw1knr6BAOmVOm32YtNTCLbVA/iK55fZWnUCjD3a4Gxz4qpQYWfpxhOmlHpk5JkraSNHzCc7SB43DwcHF5ecXHttMhO8MoN/bAZBgCuLGFEwNvwFbDwIWo07mlv7wD8i1rtUCvLywJc5YL2PbjCLfB1Q4YzDX1EWnjKdnAsxxKftrx1DFlxzUF+TaHbLTPttUcsWQaL8wITznoWIwdIWlo2woPgWIpUXMOYwYV31OofgmroHa3V4NOvkke09uhaZawg5yZCoRFohhfKPqT1ZrJ9SnRbW/WR3VTVY76ht5kRuV3eb2VWBmPU9zn56Tbe6dvFkBuzHH1JdECAqy1BzFcmQQFBebFzf1XAQARAQAB",
});

export const DOCUMENT_ENGINE_IMPORT_EXTENSION = Object.freeze({
  version: DOCUMENT_ENGINE_IMPORTER.version,
  filename: "H2Orestart.oxt",
  url: "https://github.com/ebandal/H2Orestart/releases/download/v0.8.0/H2Orestart.oxt",
  bytes: 611_297,
  sha256: "f36c19fa6b7dff1cf34114d926bdc088e6bcfa7fdc93d67eaafd3f572be1d62c",
  source: DOCUMENT_ENGINE_IMPORTER.source,
  license: DOCUMENT_ENGINE_IMPORTER.license,
});

export function documentEngineReleaseFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): DocumentEngineRelease | null {
  return RELEASES.find((release) => release.platform === platform && release.arch === arch) ?? null;
}

export function documentEngineSignatureUrl(release: DocumentEngineRelease): string {
  const url = new URL(release.url);
  url.pathname += ".asc";
  return url.href;
}

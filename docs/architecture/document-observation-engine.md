# Optional document conversion engine

This document defines the engine's required behavior. A release's validation
report records which native platforms and prerequisites were actually exercised;
the requirements below do not by themselves establish that execution evidence.

The document observation adapter uses a replaceable engine to render admitted
document bytes and obtain recalculated workbook values. The engine does not
decide who changed a file. Admission, save attribution, event sequencing,
acknowledgement and local-only privacy remain in the
[agent activity observation contract](architecture.md#agent-activity-observation).
User document, browser and terminal activity never becomes agent observation.

## Read-only results

| Input | With the optional engine | Without an installation |
| --- | --- | --- |
| DOCX | A temporary PDF rendered by the existing page reader, plus bounded paragraph/run source elements. | A bounded text outline from the isolated reader. |
| ODT | A temporary PDF rendered by the existing page reader, plus bounded paragraph source elements. | A bounded text outline from the isolated reader. |
| PPTX | A temporary PDF rendered by the existing page reader, plus bounded slide-shape source elements. | The existing slide text outline. |
| XLSX, ODS | A recalculated temporary workbook of the same format decoded by the existing table reader. | The existing cached-value grid and source recalculation signal. |
| HWP v5, HWPX | A temporary PDF page, with an ODT import representation when available, through the private-profile extension and verified Java 11 or newer. | An explicit `engine-unavailable` result. |
| PDF, CSV, TSV, XLS, text/code | The existing bounded reader. | The same reader. |

LibreOffice supplies conversion and formula recalculation behind
`DocumentObservationEngine`; its implementation remains replaceable. All source
bytes enter through existing file-read admission. The converter receives a
private copy with a host-selected filename, never authority to open or replace
the user's original path. Derived PDF and workbook bytes stay in private
temporary storage and are parsed into the existing bounded page/table response.
No converter output is published to a workspace or sent to a provider.

The [shared observation types](../../src/shared/agent-observation.ts) add page
documents to the engine result union and a host-derived session context to
parsing. Session release and engine disposal end owned processes and queued
work. They do not add an observation channel or an alternate event envelope.

Before an agent panel request is sent, the optional engine `prepare` hook verifies
the installed payload and starts the session runtime through the same bounded
FIFO used for conversion, under the tool's cancellation signal. It waits for
the session instance's readiness probe and, for HWP/HWPX, importer
registration. The panel's
existing acknowledgement window starts after preparation completes. Preparation
reads no source document bytes and creates no watch, rendered baseline or
activity event. The main process retains a preparation lease through readiness
and panel acknowledgement, then releases it on success, failure, cancellation
or timeout. A current parse, rendered view or concurrent preparation retains
the shared session; its runtime is released when its final owner leaves.

An absent installation is the only automatic engine-selection fallback.
Integrity, signature, confinement, conversion and response-contract failures
remain explicit failures. A process exiting successfully is insufficient:
expected output must exist, fit its limits and pass the ordinary bounded
reader. A recalculated result clears the panel's recalculation signal only for
that derived result. The source workbook retains its bytes and calculation
attributes, including the request for recalculation made by the editing skill.

## Optional installation

Install onboarding offers **문서 엔진 설치 / Install document engine** as an
optional step. The same controls remain available in document settings.
The card discloses download and installed size, reports progress, and provides
cancel, retry and uninstall. Each explicit user action takes effect without a
second confirmation. Skipping installation leaves existing viewers usable.

The engine is downloaded separately and stored in the private
`openFeatureNamespace("document-engine")` namespace. It is not inside the app
archive. Installation channels are private app-window main-frame operations;
they accept no caller-selected path, executable, download URL or script.
Progress state contains installation metadata only. Uninstall first ends
engine sessions and then removes only the owned installation.

The [release pins](../../src/main/document-engine-release-pins.ts) own the exact
version, platform artifacts, byte counts, SHA-256 values and signature material.
A release update changes those reviewed
pins; runtime discovery never substitutes a moving latest release or a PATH
executable. Downloads use HTTPS, a fixed host allowlist and the host's network
guard and transport. Every redirect retains those checks. TDF artifact URLs
use `?mirrorlist=0` to keep the transfer on the official distribution host.
Length and hash verification precede extraction or mounting.

The [signature verifier](../../src/main/document-engine-signature.ts) verifies
the detached TDF release signature against the in-app pinned key. It also
requires the platform's native code-signature policy where available:

- macOS checks the application and executable signature, the pinned Developer
  ID team and identifier, and the platform execution assessment.
- Windows checks Authenticode validity and the signer organization on the
  installer and extracted executable.
- Linux checks the pinned archive and derives executable integrity from its
  authenticated contents. Editing a local receipt cannot create trusted bytes.

Existing verified-executable location and ownership checks still apply.
Verification runs before first execution and again when an installation is
replaced or changes. A corrupt receipt or payload is an error, not absence.
Extraction is into Ave-owned storage and runs no downloaded maintainer script
or global installer. Platform extraction prerequisites and native validation
remain separate from the existence of a manifest entry.

An installed payload being verified is separate from its execution capability.
macOS and Linux execution require the native offline wrapper. The current
Windows backend cannot attest this stricter no-network contract and returns
`engine-confinement-unavailable`; a verified Windows download does not authorize
an unconfined conversion. Execution uses only the payload's office executable
and, for HWP/HWPX importer registration, its extension tool. No scripting
interpreter is started: on macOS 26 the pinned build's embedded Python and UNO
helper executables are terminated at launch by the operating system's
launch-constraint policy, including when run from the mounted official image.
There is no separate runtime download or PATH lookup. Linux native
compatibility remains an execution prerequisite, not a consequence of having a
release pin. HWP/HWPX additionally require a trusted Java 11 or newer
installation and successful confined registration. Missing Java or failed
registration returns `engine-runtime-unavailable` without affecting other
document formats in the same session.

## Confined session execution

The [session process owner](../../src/observation/libreoffice-process.ts) owns
one warm headless instance and one single-writer queue per admitted host
session. A private profile is selected with `-env:UserInstallation`; another
session and the user's normal office profile are never reused. The profile and
the instance's socket directory (`OSL_SOCKET_PATH`) belong to that session's
temporary output tree. The resident opens no UNO acceptor and no TCP listener.

The resident starts headless with one host-authored, empty text document from
its private output tree. The office's command-line dispatcher terminates the
instance when a forwarded request completes while no frame is open, and the
instance's own command-line open is asynchronous. This holder document keeps the
warm instance alive; it is never exported and holds no source document. Each
conversion is a fixed `--convert-to <extension>:<filter> --outdir <private
output>` command line, plus a fixed `--infilter` for HWP/HWPX, run by a confined
client on the same profile. The client forwards it through the instance's
private single-instance pipe and exits.

Forwarding starts only after the holder document's lock file exists, which the
office writes while loading that document into its frame, and after the
single-instance pipe exists, so a client can neither end the instance early
nor become a second office on the profile. The office places that pipe under
`/tmp` or `/var/tmp` when either is writable and otherwise under the private
`OSL_SOCKET_PATH`. The macOS confinement denies writes to both shared
directories. Linux confinement must do the same so that every confined process
of a session meets the same pipe; this has not been validated natively. A
client that cannot reach the instance converts by itself and is refused, as
described below.

A forwarding client exits successfully even when the forwarded conversion
fails. A result is therefore accepted only when the resident printed its
conversion receipt for the exact source, target and filter, reported no error
line, and wrote the expected file, which must then pass the bounded reader. A
client that converted the document itself is refused. Before admitted bytes are
staged, a host-authored flat ODT readiness probe proves this path.

Page formats export PDF; imported HWP/HWPX also export an ODT representation for
structured reading. XLSX/ODS export a temporary workbook of the original format.
Their formula caches come from the profile's recalculate-on-load policy:
`OOXMLRecalcMode` and `ODFRecalcMode` are set to always recalculate, which makes
the office run a hard recalculation on load whatever application saved the
workbook. ODS has no source recalculation signal in the table contract.

Execution requires the OS sandbox. Its read scope contains the verified runtime,
required OS libraries/fonts and that session's staging directory of admitted
input copies. A completed job removes its document input before the next job runs; the
warm process has no read grant for arbitrary source paths. Its write scope
contains only private temporary output, profile and cache storage. It grants no workspace write root,
real user HOME or another session's storage. IP network access is denied by the
native wrapper with no proxy exception or approval prompt. External resources
and document links cannot widen this policy. An unavailable or unprovable
confinement backend fails clearly and never retries unconfined.

The isolated profile is written before the instance starts. It sets
`DisableMacrosExecution`, the highest macro security level, no trusted macro
locations and `DisableActiveContent`, and sets Calc and Writer link updates to
never. Macro execution is disabled for the profile rather than per load.
Headless mode alone is not the macro or network boundary. A conversion may read
an untrusted parser input; signature verification establishes executable
provenance, not the safety of that document.

The [session process owner](../../src/observation/libreoffice-process.ts) owns
per-job input/output bounds, per-session queue count/bytes and temporary-tree
entry/byte bounds; the adapter's view limits remain in the shared observation
contract. Execution and shutdown deadlines come from the
[shared timeout policy](../../src/shared/tool-timeout-policy.ts). Cancellation,
session release, view loss and host shutdown end corresponding queued or active
work; process termination precedes deletion of its private profile and cache.
Processes remain registered with host child-lifecycle management. A crash or
contract violation is reported as an error, with no empty success or suppressed
dialog used as recovery.

## Structured changes

DOCX paragraph/run, ODT paragraph and PPTX slide-shape addresses identify bounded
source text from admitted packages. Paragraph, run and slide indices are
zero-based; a shape includes its source ID. The
[page response contract](../../src/shared/preview-page-document.ts) owns those
addresses and their bounds. ZIP/XML admission rejects malformed containers,
entity declarations and invalid relationships before extraction of text.

The adapter compares this representation only after matching stable source
bytes to the admitted before/after digest chain. The existing tool-bound journal's
`begin`/`commit` records can supply that chain for a page target; its provisional
`cell` records remain table-only. The adapter emits ordinary `element`
events with bounded `before` and `after` strings, followed by the verified
snapshot. Rendering layout does not create agent attribution. A raster page
alone cannot establish paragraph or shape identity. PPTX shapes require their
declared `cNvPr` IDs; missing or duplicate IDs are refused, including within
validated shape groups. Each shape address combines the slide index and validated
source ID.
The renderer acknowledges an image snapshot after the image loads, or an
outline after layout commits, and releases its binding when the file, selection,
session or owning view changes.

## Korean document importer

H2Orestart is an optional pinned import extension installed through `unopkg`
only into Ave's isolated profile. Its upstream source is GPL-3.0. Installation
controls expose the fixed upstream source and license links from the
[shared importer metadata](../../src/shared/document-engine-importer.ts).
The installation receipt identifies the engine slot; importer bytes are checked
against the shared pin before registration. The
extension imports HWP v5/HWPX for passive viewing. Ave exposes no
HWP/HWPX serializer, editing operation or source-file save path.

The extension contains Java code; its pinned source declares Java 11. The
downloaded office application does not itself establish that a compatible JRE
is present. HWP/HWPX support requires trusted Java 11 or newer, a confined version
probe and successful private-profile registration/import;
an `.oxt` file's presence is insufficient. Missing Java or a failed import is
reported explicitly. Ordinary DOCX/ODT/PPTX/XLSX/ODS conversion does not prove
this importer works. Importer logs can include document contents, so its HOME,
profile and caches remain local, private and subject to session cleanup.

Registering the extension's Java component makes the extension tool start the
office's separate UNO helper process. On macOS 26 the pinned build's helper is
terminated at launch by the operating system's launch-constraint policy, so
registration fails, HWP/HWPX return `engine-runtime-unavailable`, and the
operating system records a crash report for the helper. Other formats in the
session keep working. HWP/HWPX import on macOS therefore depends on a release
whose helper can run there; the pin is not changed to hide this.

## Validation and upstream references

Targeted tests must cover engine absence, integrity failures, serialized work,
cancellation, bounded results, source preservation, registered-frame delivery
and element addressing. Native tests must separately establish process confinement,
network denial, actual formula results and importer behavior. Mocked process
tests, a passing build and a pinned download do not supply native execution
proof. The delivery report records platforms actually exercised and remaining
runtime prerequisites.

Primary sources below were accessed on **2026-10-27**:

- [TDF release directory](https://download.documentfoundation.org/libreoffice/stable/26.8.1/)
  and [artifact metadata](https://download.documentfoundation.org/libreoffice/stable/26.8.1/mac/aarch64/LibreOffice_26.8.1_MacOS_aarch64.dmg.mirrorlist)
  publish fixed distribution artifacts, sizes, hashes and detached signatures.
- [Startup parameters](https://help.libreoffice.org/latest/en-GB/text/shared/guide/start_parameters.html)
  document headless mode, alternate user profiles and UNO acceptors. Ave's
  private transport and sandbox policy are host
  requirements, not guarantees made by those CLI flags.
- The command-line [dispatch watcher](https://github.com/LibreOffice/core/blob/master/desktop/source/app/dispatchwatcher.cxx)
  prints the conversion receipt before storing, reports store failures only on
  the office's own error stream, and terminates the office when no frame
  remains; the [request handler](https://github.com/LibreOffice/core/blob/master/desktop/source/app/officeipcthread.cxx)
  forwards a second instance's command line without returning that error state.
- The [pipe implementation](https://github.com/LibreOffice/core/blob/master/sal/osl/unx/pipe.cxx)
  selects `/tmp`, then `/var/tmp`, and only then `OSL_SOCKET_PATH`.
- The configuration schemas for
  [Common](https://github.com/LibreOffice/core/blob/master/officecfg/registry/schema/org/openoffice/Office/Common.xcs)
  (`DisableMacrosExecution`), [Calc](https://github.com/LibreOffice/core/blob/master/officecfg/registry/schema/org/openoffice/Office/Calc.xcs)
  (`Content/Update/Link`, `Formula/Load/OOXMLRecalcMode`, `ODFRecalcMode`) and
  [Writer](https://github.com/LibreOffice/core/blob/master/officecfg/registry/schema/org/openoffice/Office/Writer.xcs)
  (`Content/Update/Link`) define the profile values above.
- The spreadsheet [document shell](https://github.com/LibreOffice/core/blob/master/sc/source/ui/docshell/docsh.cxx)
  performs a hard recalculation on ODF load when `ODFRecalcMode` is set to
  always; the generator check applies only to the ask mode.
- The pinned extension's `registry/H2Orestart_filters.xcu` declares the
  `Hwp2002_Reader` import filter.
- [Macro security levels](https://help.libreoffice.org/latest/en-US/text/shared/optionen/macrosecurity_sl.html)
  explain that the highest level still permits trusted locations; the isolated
  profile therefore supplies none.
- [H2Orestart release](https://github.com/ebandal/H2Orestart/releases/tag/v0.8.0),
  [source](https://github.com/ebandal/H2Orestart/tree/2a35d9e1bf6fb67fcde4f4c42d89134d65f9df55)
  and [license](https://github.com/ebandal/H2Orestart/blob/2a35d9e1bf6fb67fcde4f4c42d89134d65f9df55/COPYING)
  identify the imported extension and its source terms; the pinned
  [classpath](https://github.com/ebandal/H2Orestart/blob/2a35d9e1bf6fb67fcde4f4c42d89134d65f9df55/.classpath)
  declares the Java target.
- [Security advisories](https://www.libreoffice.org/security/)
  are part of release-pin maintenance; a signed release is not a substitute
  for keeping its parser implementation current.

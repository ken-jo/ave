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
| HWP v5, HWPX | macOS: an explicit `engine-format-unsupported-on-platform` result (see [Korean document importer](#korean-document-importer)). Where the engine is offered and imports HWP: a temporary PDF page, with an ODT import representation when available, through the private-profile extension and verified Java 11 or newer. | An explicit `engine-unavailable` result; on macOS, `engine-format-unsupported-on-platform`. |
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
the installed app and Ave's extension and starts the session runtime through the same bounded
FIFO used for conversion, under the tool's cancellation signal. It waits for
the session instance's readiness probe and, for HWP/HWPX, importer
registration. The panel's
existing acknowledgement window starts after preparation completes. Preparation
reads no source document bytes and creates no watch, rendered baseline or
activity event. The main process retains a preparation lease through readiness
and panel acknowledgement, then releases it on success, failure, cancellation
or timeout. A current parse, rendered view or concurrent preparation retains
the shared session; its runtime is released when its final owner leaves.

An absent installation is the only automatic engine-selection fallback. An
installation that is being installed or removed has no admitted receipt and is
absent to the engine, so documents opened meanwhile keep the existing reader.
Integrity, signature, conversion and response-contract failures
remain explicit failures. A process exiting successfully is insufficient:
expected output must exist, fit its limits and pass the ordinary bounded
reader. A recalculated result clears the panel's recalculation signal only for
that derived result. The source workbook retains its bytes and calculation
attributes, including the request for recalculation made by the editing skill.

## Optional installation

LibreOffice is a verified third-party app that the user installs like any other
app, such as a browser. Ave does not download, bundle or confine it; the
document engine runs only while it is installed (owner decision 2026-11-28).
Install onboarding and document settings show **문서 엔진 (LibreOffice) /
Document engine (LibreOffice)** as an optional step. Without the app the card
reports `app-missing`, links to the LibreOffice download page and offers
"check again"; existing viewers stay usable.

The [installation owner](../../src/main/document-engine-installation.ts) looks
for the app only at the platform's standard locations, never on PATH:

- macOS: `/Applications/LibreOffice.app`, then `~/Applications/LibreOffice.app`.
  Only macOS is offered.
- Windows: not offered; the session's readiness check knows only the POSIX
  single-instance pipe.
- Linux: not offered (lead decision 2026-11-28, pending the owner's
  correction). Earlier builds offered a confined Linux x64 engine; Linux loses
  it. The unconfined office's `/tmp` pipe accepts forwarded command lines, so
  anything that can connect to it could drive the office to read files as the
  user. The slice 8 flip made Linux extensions holders, which cannot create a
  Unix socket, but it could not prove the pipe unreachable: its validation host
  has no office to run, and host-owned offline processes stay on the wrap, whose
  Unix-socket filter depends on srt finding its seccomp helper. Linux stays
  unsupported until a native test drives a live office pipe from every
  remaining wrap and is refused.

On Windows and Linux the status is `unsupported` with the same payload and copy
Windows had before, and the install action returns `unsupported-platform`
before any discovery, download or signature check. On Windows any receipt is
refused as integrity-failed, as it always was. On Linux the payload an earlier
build installed can still be removed. Its schema-2 receipt is validated as that
build validated it (seven keys, release 26.8.1 linux x64, slot name, digests),
and the slot must be a plain private directory in the namespace. The status
then carries `legacyPayload` and the card offers "Uninstall engine". Any other
receipt is refused.

Ave admits the app it finds once per app identity, off the main thread and
without blocking status reads (`verifying-installation`):

- macOS requires the [publisher signature](../../src/main/document-engine-signature.ts):
  `codesign --verify --deep --strict`, TDF's Developer ID team `7P5S3ZLCN7` and
  identifier `org.libreoffice.script`, and the Gatekeeper execution assessment.
  The seal is verified over the whole bundle, and both executables must resolve
  directly into the bundle's `Contents/MacOS`, so neither they nor the version
  in the app's `Info.plist` can come from outside the sealed bundle.

The admission is bound to the app's identity (device, inode, mtime and ctime of
its root and executables). An update or replacement makes it a different app,
which is admitted afresh; a change found at launch invalidates the old
admission in the same process. A failed admission stays failed until the app,
Ave's slot or the lifecycle changes. No minimum LibreOffice version is enforced.

Ave's own part is the pinned HWP import extension, H2Orestart. The install
action downloads only that file over HTTPS from its fixed GitHub release origin
through the host's network guard, checks its length and SHA-256 against the
[release pin](../../src/main/document-engine-release-pins.ts), and stores it in
a slot of the private `openFeatureNamespace("document-engine")` namespace.
A schema 3 receipt records only that slot. Uninstall ends engine sessions and
removes only Ave's slot; the app stays the user's. A slot and schema 2 receipt
left by an earlier Ave that installed its own LibreOffice copy are reported as
absent and removed by the next install or uninstall. Installation channels are
private app-window main-frame operations and accept no caller-selected path,
executable, download URL or script. A corrupt receipt is an error, not absence.
Each launch rechecks the extension bytes against the pin, and the synchronous
check just before spawn covers the recorded anchors (app root, executables,
slot and extension). Same-user in-place changes between that recheck and
process creation are outside the guarantee on every platform.

## Session execution

The [session process owner](../../src/observation/libreoffice-process.ts) owns
one warm headless instance and one single-writer queue per admitted host
session. A private profile is selected with `-env:UserInstallation`; another
session and the user's normal office profile are never reused. The profile
belongs to that session's temporary output tree. The resident opens no UNO
acceptor and no TCP listener.

The resident starts headless with one host-authored, empty text document from
its private output tree. The office's command-line dispatcher terminates the
instance when a forwarded request completes while no frame is open, and the
instance's own command-line open is asynchronous. This holder document keeps the
warm instance alive; it is never exported and holds no source document. Each
conversion is a fixed `--convert-to <extension>:<filter> --outdir <private
output>` command line, plus a fixed `--infilter` for HWP/HWPX, run by a
client on the same profile. The client forwards it through the instance's
private single-instance pipe and exits.

Forwarding starts only after the holder document's lock file exists, which the
office writes while loading that document into its frame, and after the
single-instance pipe exists, so a client can neither end the instance early
nor become a second office on the profile. The office binds that pipe under
`/tmp` whenever it is writable, which it is for the installed app, and uses
`OSL_SOCKET_PATH` only otherwise (measured with LibreOffice 26.8.3.1 on macOS).
Its name is `OSL_PIPE_<uid>_SingleOfficeIPC_<hash>`, the hash being the MD5 of
the profile URL in UTF-16LE printed without zero padding, so the session's fresh
profile makes it unique. The engine refuses a start when that name already
exists, accepts only a socket owned by the user, and removes the name with the
resident's exit receipt, because a killed office leaves it behind. A client that
cannot reach the instance converts by itself and is refused, as described below.

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

The engine runs unconfined, as the app the user installed (owner decision
2026-11-28). It is started directly, with no shell, by absolute path from the
admitted installation, in its own process group under host child-lifecycle
management. Its environment is the host's sanitized child environment with
HOME, TMPDIR and the XDG directories pointed into the session's private output
tree. It receives only private copies of admitted input under host-selected
names, never a source path or workspace root, and each completed job removes its
input before the next one runs. Network access is not blocked by Ave; the
profile below turns off the office's own remote content and link updates.

The isolated profile is written before the instance starts. It sets
`DisableMacrosExecution`, the highest macro security level, no trusted macro
locations, `DisableActiveContent` and `BlockUntrustedRefererLinks`, and sets
Calc and Writer link updates to never. The two settings number their choices
differently: Calc's `1` and Writer's `0` mean never, and Writer's `2` means
always. Macro execution is disabled for the profile rather than per load.
With the app unconfined these settings are the barrier against a document's
own references. Measured with 26.8.3.1 on macOS, a linked local-file section
and a linked HTTP section are blocked by each barrier alone: active content
off, no trusted location, and link updates never. A profile without all three
reads both; the native document-reads test pins each case. Calc's link barrier
is unproven: under a fully permissive profile no spreadsheet construct leaked
(linked sheet, linked range, external reference, DDE link, WEBSERVICE; every
Calc link value), so no control exists. The test names that case and skips it
with this reason.
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

Each session's private temporary directory holds an owner record with the
creating Ave process ID, outside the engine's output tree. If Ave itself
crashes or is killed, its resident outlives it and the directory keeps its
read-only input copies and profile. At boot, the engine host removes such a
directory only when it is a real 0700 directory of this user, carries a valid
owner record, and its owner is not running. It first ends this user's processes
that run with that directory's unique profile argument. Unmarked directories,
live owners, links and other users' entries are left alone.

## Host composition

The [engine host](../../src/observation/document-engine-host.ts) is the single
module that names the concrete engine. The observation runtime, installation
IPC, shutdown and boot hygiene use only it and the `DocumentObservationEngine`
contract. Replacing the engine changes that module, not the host.

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
installed office application does not itself establish that a compatible JRE
is present. HWP/HWPX support requires trusted Java 11 or newer, a version
probe and successful private-profile registration/import;
an `.oxt` file's presence is insufficient. Missing Java or a failed import is
reported explicitly. Ordinary DOCX/ODT/PPTX/XLSX/ODS conversion does not prove
this importer works. Importer logs can include document contents, so its HOME,
profile and caches remain local, private and subject to session cleanup.

Registering the extension's Java component makes the extension tool start the
office's separate UNO helper process. On macOS 26 the LibreOffice 26.8.1
helper is terminated at launch by the operating system
(`CODESIGNING / Launch Constraint Violation`, reproduced from the mounted
official image), which also leaves a crash report on the user's machine.

The owner therefore decided that HWP/HWPX are **not supported on macOS**. This
is a supported-format decision held in one place, the platform capability in the
[engine](../../src/observation/libreoffice-engine.ts): on macOS, preparing or
parsing HWP/HWPX returns `engine-format-unsupported-on-platform` before any
installation lookup or engine call, so no extension tool or helper is ever
started and no crash report is produced. The panel and tool descriptions say
the format is not supported on macOS yet; every other format keeps working.
The gate is lifted when a TDF build's helper runs on macOS, proven by
native importer registration and an HWP/HWPX conversion there.

## Validation and upstream references

Targeted tests must cover engine absence, integrity failures, serialized work,
cancellation, bounded results, source preservation, registered-frame delivery
and element addressing. Native tests must separately establish a real
conversion with the installed app, actual formula results and importer
behavior. Mocked process tests and a passing build do not supply native
execution proof. The delivery report records platforms actually exercised and remaining
runtime prerequisites.

Primary sources below were accessed on **2026-10-27**:

- [LibreOffice download page](https://www.libreoffice.org/download/download-libreoffice/), where the user installs the app
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

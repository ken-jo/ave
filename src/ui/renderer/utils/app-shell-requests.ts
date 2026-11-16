/** Requests a view deep in the tree makes to the app shell, which owns panes and surfaces. The shell registers the one
 * handler; a request made while no shell is mounted is refused (false), never queued. */
export interface TerminalAtRequest {
  /** The folder the terminal starts in. */
  dir: string;
  /** The project the terminal belongs to. */
  projectRoot: string;
}

let terminalAtHandler: ((request: TerminalAtRequest) => void) | null = null;

/** The shell's side: handle "open a terminal in this folder". Returns the unregister. */
export function handleTerminalAtRequests(handler: (request: TerminalAtRequest) => void): () => void {
  terminalAtHandler = handler;
  return () => {
    if (terminalAtHandler === handler) terminalAtHandler = null;
  };
}

/** A file or folder of a project, to be shown selected in a folder view. */
export interface FolderViewAtRequest {
  /** Absolute path inside `projectRoot`. */
  path: string;
  projectRoot: string;
}

let folderViewAtHandler: ((request: FolderViewAtRequest) => void) | null = null;

/** The shell's side: handle "show this path in a folder view". Returns the unregister. */
export function handleFolderViewAtRequests(handler: (request: FolderViewAtRequest) => void): () => void {
  folderViewAtHandler = handler;
  return () => {
    if (folderViewAtHandler === handler) folderViewAtHandler = null;
  };
}

/**
 * Ask the shell to open a folder view of `projectRoot` with `path` selected (a file shows in the viewer, a folder opens as
 * the deepest column). False when no shell is there to do it.
 */
export function requestFolderViewAt(request: FolderViewAtRequest): boolean {
  if (folderViewAtHandler === null) return false;
  folderViewAtHandler(request);
  return true;
}

/** A settings tab and, optionally, the section of it to bring into view. */
export interface SettingsSectionRequest {
  tab: string;
  section?: string;
}

let settingsSectionHandler: ((request: SettingsSectionRequest) => void) | null = null;

/** The shell's side: handle "show this setting". Returns the unregister. */
export function handleSettingsSectionRequests(handler: (request: SettingsSectionRequest) => void): () => void {
  settingsSectionHandler = handler;
  return () => {
    if (settingsSectionHandler === handler) settingsSectionHandler = null;
  };
}

/** Ask the shell to show a setting. False when no shell is there to do it. */
export function requestSettingsSection(request: SettingsSectionRequest): boolean {
  if (settingsSectionHandler === null) return false;
  settingsSectionHandler(request);
  return true;
}

/** Ask the shell to open a terminal in `dir`. False when no shell is there to do it. */
export function requestTerminalAt(request: TerminalAtRequest): boolean {
  if (terminalAtHandler === null) return false;
  terminalAtHandler(request);
  return true;
}

/** Closed command vocabulary. Unknown names and bindings never acquire known effects. */
type PowerShellCommandEffect = "local" | "read" | "network" | "launcher" | "dispatch" | "file-write" | "variable-read" | "variable-write" | "provider-write";

export interface PowerShellCommandPolicy {
  aliases: readonly string[];
  effects: readonly [PowerShellCommandEffect, ...PowerShellCommandEffect[]];
  /** A trailing '?' is a switch; '*' consumes the remaining argument list. */
  parameters: readonly string[];
  /** Destination bindings whose filesystem paths can send data to a share. */
  destination?: { parameters: readonly string[]; position: number };
  /** Literal property reads understood for this command's output objects. */
  members?: readonly string[];
}

const HTTP_PARAMETERS = ["uri", "method", "infile", "body", "form", "headers", "outfile", "contenttype", "credential", "timeoutsec", "usebasicparsing?"];
const PATH_PARAMETERS = ["path", "literalpath", "filter", "include", "exclude", "force?"];
const VARIABLE_PARAMETERS = ["name", "value", "scope", "option", "visibility", "description", "force?", "passthru?"];
const ITEM_PARAMETERS = [...PATH_PARAMETERS, "value", "destination", "name", "itemtype", "recurse?", "passthru?"];
const COPY_DESTINATION = { parameters: ["destination"], position: 1 };
const CONTENT_DESTINATION = { parameters: ["path", "literalpath"], position: 0 };
const PROPERTY_PARAMETERS = ["property*", "inputobject"];

/** Aliases are the union of built-in spellings across supported host editions. */
export const POWERSHELL_COMMAND_POLICIES: Readonly<Record<string, PowerShellCommandPolicy>> = Object.freeze(Object.assign(Object.create(null) as Record<string, PowerShellCommandPolicy>, {
  "invoke-webrequest": { aliases: ["iwr", "curl", "wget"], effects: ["network"], parameters: HTTP_PARAMETERS, members: ["content", "statuscode", "headers", "rawcontent"] },
  "invoke-restmethod": { aliases: ["irm"], effects: ["network"], parameters: HTTP_PARAMETERS },
  "get-content": { aliases: ["gc", "cat", "type"], effects: ["read"], parameters: [...PATH_PARAMETERS, "raw?", "encoding", "totalcount", "tail", "delimiter", "wait?"] },
  "get-item": { aliases: ["gi"], effects: ["read", "variable-read"], parameters: PATH_PARAMETERS },
  "get-childitem": { aliases: ["gci", "dir", "ls"], effects: ["read"], parameters: [...PATH_PARAMETERS, "recurse?", "name?", "file?", "directory?", "depth"], members: ["name", "fullname", "length", "extension", "basename", "psiscontainer"] },
  "select-string": { aliases: ["sls"], effects: ["read"], parameters: [...PATH_PARAMETERS, "pattern", "inputobject", "raw?", "simplematch?", "casesensitive?", "quiet?", "list?"] },
  "import-clixml": { aliases: [], effects: ["read"], parameters: ["path", "literalpath", "skip", "first"] },
  "import-csv": { aliases: ["ipcsv"], effects: ["read"], parameters: ["path", "literalpath", "delimiter", "header", "encoding", "useculture?"] },
  "format-hex": { aliases: ["fhx"], effects: ["read"], parameters: ["path", "literalpath", "inputobject", "encoding", "count", "offset"] },
  "get-secret": { aliases: [], effects: ["read"], parameters: ["name", "vault", "asplaintext?"] },
  "get-storedcredential": { aliases: [], effects: ["read"], parameters: ["target", "ascredentialobject?"] },
  "get-variable": { aliases: ["gv"], effects: ["variable-read"], parameters: ["name", "scope", "valueonly?", "include", "exclude"] },
  "set-variable": { aliases: ["sv", "set"], effects: ["variable-write"], parameters: VARIABLE_PARAMETERS },
  "new-variable": { aliases: ["nv"], effects: ["variable-write"], parameters: VARIABLE_PARAMETERS },
  "clear-variable": { aliases: ["clv"], effects: ["variable-write"], parameters: ["name", "scope", "force?", "include", "exclude"] },
  "remove-variable": { aliases: ["rv"], effects: ["variable-write"], parameters: ["name", "scope", "force?", "include", "exclude"] },
  "set-item": { aliases: ["si"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "new-item": { aliases: ["ni"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "clear-item": { aliases: ["cli"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "remove-item": { aliases: ["ri", "rm", "rmdir", "rd", "del", "erase"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "copy-item": { aliases: ["cpi", "cp", "copy"], effects: ["provider-write", "file-write"], destination: COPY_DESTINATION, parameters: [...ITEM_PARAMETERS, "tosession", "fromsession", "container?"] },
  "move-item": { aliases: ["mi", "mv", "move"], effects: ["provider-write", "file-write"], destination: COPY_DESTINATION, parameters: ITEM_PARAMETERS },
  "rename-item": { aliases: ["rni", "ren"], effects: ["provider-write", "dispatch"], parameters: [...ITEM_PARAMETERS, "newname"] },
  "set-content": { aliases: ["sc"], effects: ["provider-write", "file-write"], destination: CONTENT_DESTINATION, parameters: [...ITEM_PARAMETERS, "encoding", "nonewline?"] },
  "add-content": { aliases: ["ac"], effects: ["provider-write", "file-write"], destination: CONTENT_DESTINATION, parameters: [...ITEM_PARAMETERS, "encoding", "nonewline?"] },
  "out-file": { aliases: [], effects: ["file-write"], destination: { parameters: ["filepath", "literalpath"], position: 0 }, parameters: ["filepath", "literalpath", "inputobject", "encoding", "append?", "force?", "noclobber?", "width", "nonewline?"] },
  "export-csv": { aliases: ["epcsv"], effects: ["file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "literalpath", "inputobject", "delimiter", "encoding", "append?", "force?", "noclobber?", "notypeinformation?", "useculture?"] },
  "export-clixml": { aliases: [], effects: ["file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "literalpath", "inputobject", "depth", "encoding", "force?", "noclobber?"] },
  "export-alias": { aliases: ["epal"], effects: ["file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "literalpath", "name", "scope", "description", "as", "append?", "force?", "noclobber?"] },
  "export-pssession": { aliases: ["epsn"], effects: ["network", "file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "session", "commandname*", "commandtype*", "module*", "allowclobber?", "force?", "encoding"] },
  "clear-content": { aliases: ["clc"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "set-itemproperty": { aliases: ["sp"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "get-itemproperty": { aliases: ["gp"], effects: ["read", "variable-read"], parameters: ITEM_PARAMETERS },
  "get-itempropertyvalue": { aliases: ["gpv"], effects: ["read", "variable-read"], parameters: ITEM_PARAMETERS },
  "start-bitstransfer": { aliases: [], effects: ["network"], parameters: ["source", "destination", "transfertype", "credential", "asynchronous?", "displayname", "description"] },
  "send-mailmessage": { aliases: [], effects: ["network"], parameters: ["to", "from", "subject", "smtpserver", "body", "attachments", "credential", "port", "usessl?", "bodyashtml?", "cc", "bcc"] },
  "resolve-dnsname": { aliases: [], effects: ["network"], parameters: ["name", "server", "type", "dnsonly?", "quicktimeout?"] },
  "test-netconnection": { aliases: ["tnc"], effects: ["network"], parameters: ["computername", "port", "informationlevel", "traceroute?", "hops"] },
  "test-connection": { aliases: [], effects: ["network"], parameters: ["computername", "targetname", "count", "quiet?", "timeoutseconds"] },
  "new-pssession": { aliases: ["nsn"], effects: ["network"], parameters: ["computername", "connectionuri", "credential", "name", "port", "usessl?"] },
  "enter-pssession": { aliases: ["etsn"], effects: ["network"], parameters: ["computername", "connectionuri", "credential", "session", "id", "name"] },
  "invoke-command": { aliases: ["icm"], effects: ["network", "launcher"], parameters: ["computername", "connectionuri", "credential", "session", "scriptblock", "filepath", "argumentlist*"] },
  "new-webserviceproxy": { aliases: [], effects: ["network"], parameters: ["uri", "credential", "namespace", "class"] },
  "start-process": { aliases: ["saps", "start"], effects: ["launcher"], parameters: ["filepath", "argumentlist*", "workingdirectory", "credential", "wait?", "nonewwindow?", "passthru?", "verb", "windowstyle"] },
  "invoke-expression": { aliases: ["iex"], effects: ["launcher"], parameters: ["command*"] },
  "start-job": { aliases: ["sajb"], effects: ["launcher"], parameters: ["scriptblock", "filepath", "name", "argumentlist*"] },
  "add-type": { aliases: [], effects: ["launcher"], parameters: ["typedefinition", "path", "literalpath", "memberdefinition", "name", "namespace", "language"] },
  "set-alias": { aliases: ["sal"], effects: ["launcher"], parameters: VARIABLE_PARAMETERS },
  "new-alias": { aliases: ["nal"], effects: ["launcher"], parameters: VARIABLE_PARAMETERS },
  "import-alias": { aliases: ["ipal"], effects: ["launcher"], parameters: ["path", "scope", "force?"] },
  "foreach-object": { aliases: ["foreach", "%"], effects: ["dispatch"], parameters: ["process*", "begin", "end", "remainingscripts*", "parallel", "membername", "argumentlist*", "inputobject", "throttlelimit", "timeoutseconds", "asjob?", "usenewrunspace?"] },
  "where-object": { aliases: ["where", "?"], effects: ["dispatch"], parameters: ["filterscript", "property", "value", "inputobject", "eq?", "ne?", "like?", "match?", "not?", "contains?", "in?", "gt?", "ge?", "lt?", "le?"] },
  "select-object": { aliases: ["select"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "expandproperty", "first", "last", "skip", "unique?"] },
  "sort-object": { aliases: ["sort"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "descending?", "unique?", "stable?", "casesensitive?"] },
  "group-object": { aliases: ["group"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "noelement?", "ashashtable?", "asstring?", "casesensitive?"] },
  "measure-object": { aliases: ["measure"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "sum?", "average?", "maximum?", "minimum?", "standarddeviation?", "line?", "word?", "character?", "ignorewhitespace?"] },
  "format-table": { aliases: ["ft"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "groupby", "autosize?", "hidetableheaders?", "wrap?", "force?", "view"] },
  "format-list": { aliases: ["fl"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "groupby", "force?", "view"] },
  "format-wide": { aliases: ["fw"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "groupby", "autosize?", "column", "force?", "view"] },
  "format-custom": { aliases: ["fc"], effects: ["dispatch"], parameters: [...PROPERTY_PARAMETERS, "groupby", "depth", "force?", "view"] },
  "register-objectevent": { aliases: [], effects: ["launcher"], parameters: ["inputobject", "eventname", "sourceidentifier", "action", "messagedata", "supportevent?", "forward?", "maxtriggercount"] },
  "register-engineevent": { aliases: [], effects: ["launcher"], parameters: ["sourceidentifier", "action", "messagedata", "supportevent?", "forward?", "maxtriggercount"] },
  "register-wmievent": { aliases: [], effects: ["launcher"], parameters: ["class", "query", "namespace", "computername", "sourceidentifier", "action", "messagedata", "credential", "supportevent?"] },
  "register-cimindicationevent": { aliases: [], effects: ["launcher"], parameters: ["classname", "query", "namespace", "computername", "sourceidentifier", "action", "messagedata", "cimsession", "supportevent?"] },
  "write-output": { aliases: ["echo", "write"], effects: ["local"], parameters: ["inputobject", "noenumerate?"] },
  "write-host": { aliases: [], effects: ["local"], parameters: ["object*", "nonewline?", "separator", "foregroundcolor", "backgroundcolor"] },
  "test-path": { aliases: [], effects: ["local"], parameters: [...PATH_PARAMETERS, "pathtype", "isvalid?", "newerthan", "olderthan"] },
  "out-string": { aliases: [], effects: ["local"], parameters: ["inputobject", "width", "stream?"] },
  "get-date": { aliases: [], effects: ["local"], parameters: ["date", "format", "uformat"] },
  "join-path": { aliases: [], effects: ["local"], parameters: ["path", "childpath", "additionalchildpath*", "resolve?"] },
  "expand-archive": { aliases: [], effects: ["local"], parameters: ["path", "literalpath", "destinationpath", "force?", "passthru?"] },
  "new-object": { aliases: [], effects: ["launcher"], parameters: ["typename", "argumentlist*", "comobject", "property"] },
} satisfies Record<string, PowerShellCommandPolicy>));

const commandAliases = new Map(Object.entries(POWERSHELL_COMMAND_POLICIES).flatMap(([name, policy]) => policy.aliases.map((alias) => [alias, name] as const)));

export function canonicalPowerShellName(text: string): string {
  // Qualification selects another command identity; it never inherits a built-in policy.
  const name = text.toLowerCase();
  return commandAliases.get(name) ?? name;
}

export function powerShellCommandsWithEffect(effect: PowerShellCommandPolicy["effects"][number]): Set<string> {
  return new Set(Object.entries(POWERSHELL_COMMAND_POLICIES).filter(([, policy]) => policy.effects.includes(effect)).map(([name]) => name));
}

export const POWERSHELL_ANALYSIS_LIMITS = Object.freeze({
  inputChars: 8_192,
  chars: 65_536,
  steps: 16_384,
  frameSteps: 4_096,
  depth: 16,
  expressionDepth: 24,
});

export type PowerShellExpressionKind = "literal" | "interpolation" | "group" | "hashtable" | "concatenation" | "format" | "join-path";

export class PowerShellBudgetError extends Error {}

/** One budget spans lexing, value analysis, scans and every nested script. */
export class PowerShellAnalysisBudget {
  steps = 0;
  chars = 0;
  exhausted = false;
  private readonly frames: number[] = [];
  private expressionDepth = 0;
  constructor(private readonly disabled: ReadonlySet<PowerShellExpressionKind> = new Set()) {}

  spend(steps = 1, chars = 0): void {
    const frame = this.frames.length - 1;
    if (this.steps + steps > POWERSHELL_ANALYSIS_LIMITS.steps || this.chars + chars > POWERSHELL_ANALYSIS_LIMITS.chars
      || (frame >= 0 && this.frames[frame]! + steps > POWERSHELL_ANALYSIS_LIMITS.frameSteps)) this.exceed();
    this.steps += steps;
    this.chars += chars;
    if (frame >= 0) this.frames[frame]! += steps;
  }

  enter(source: string): void {
    if (source.length > POWERSHELL_ANALYSIS_LIMITS.inputChars || this.frames.length >= POWERSHELL_ANALYSIS_LIMITS.depth) this.exceed();
    this.frames.push(0);
    this.spend(1, source.length);
  }

  leave(): void { this.frames.pop(); }

  expression<T>(tokens: number, read: () => T): T {
    if (this.expressionDepth >= POWERSHELL_ANALYSIS_LIMITS.expressionDepth) this.exceed();
    this.spend(tokens + 1);
    this.expressionDepth += 1;
    try { return read(); } finally { this.expressionDepth -= 1; }
  }

  supports(kind: PowerShellExpressionKind): boolean { this.spend(); return !this.disabled.has(kind); }

  private exceed(): never {
    this.exhausted = true;
    throw new PowerShellBudgetError("Analysis budget exceeded");
  }
}

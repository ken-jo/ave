// Closed command vocabulary. Unknown names and bindings never acquire known effects.
type PowerShellCommandEffect = "local" | "read" | "network" | "launcher" | "dispatch" | "file-write" | "variable-read" | "variable-write" | "provider-write" | "cwd-write";

interface PowerShellPathBinding {
  parameters: readonly string[];
  position?: number;
  // Named variable destinations select a non-file parameter set.
  variableParameters?: readonly string[];
}

export interface PowerShellCommandPolicy {
  aliases: readonly string[];
  effects: readonly [PowerShellCommandEffect, ...PowerShellCommandEffect[]];
  // A trailing '?' is a switch; '*' consumes the remaining argument list.
  parameters: readonly string[];
  // Destination bindings whose filesystem paths can send data to a share.
  destination?: PowerShellPathBinding & { kind?: "printer" | "mail" };
  // Native payload grammar; all other catalogue forms remain opaque.
  native?: "opaque" | "cmd" | "wmic" | "dotnet";
  // Credential-store access and explicit native transfer forms remain floors.
  credential?: true | RegExp;
  sink?: RegExp;
}

const HTTP_PARAMETERS = ["uri", "method", "infile", "body", "form", "headers", "outfile", "contenttype", "credential", "timeoutsec", "usebasicparsing?"];
const PATH_PARAMETERS = ["path", "literalpath", "filter", "include", "exclude", "force?"];
const VARIABLE_PARAMETERS = ["name", "value", "scope", "option", "visibility", "description", "force?", "passthru?"];
const ITEM_PARAMETERS = [...PATH_PARAMETERS, "value", "destination", "name", "itemtype", "recurse?", "passthru?"];
const COPY_DESTINATION = { parameters: ["destination"], position: 1 };
const CONTENT_DESTINATION = { parameters: ["path", "literalpath"], position: 0 };
const PROPERTY_PARAMETERS = ["property*", "inputobject"];

function nativePolicy(effects: PowerShellCommandPolicy["effects"], native: NonNullable<PowerShellCommandPolicy["native"]> = "opaque"): PowerShellCommandPolicy {
  return { aliases: [], effects, parameters: [], native };
}

// Native effects: LOLBAS https://lolbas-project.github.io/ (Execute, Download, Upload, AWL bypass catalogue snapshot, 2026-10-15), plus transport and host spellings. Only explicitly modeled payload grammars acquire literal code. Cmdlet aliases are the union of built-in spellings across supported editions.
export const POWERSHELL_COMMAND_POLICIES: Readonly<Record<string, PowerShellCommandPolicy>> = Object.freeze(Object.assign(Object.create(null) as Record<string, PowerShellCommandPolicy>, {
  "acccheckconsole.exe": nativePolicy(["launcher"]),
  "addinutil.exe": nativePolicy(["launcher"]),
  "adplus.exe": nativePolicy(["launcher"]),
  "advpack.dll": nativePolicy(["launcher"]),
  "agentexecutor.exe": nativePolicy(["launcher"]),
  "appcert.exe": nativePolicy(["launcher"]),
  "appinstaller.exe": nativePolicy(["network"]),
  "applauncher.exe": nativePolicy(["launcher"]),
  "appvlp.exe": nativePolicy(["launcher"]),
  "at.exe": nativePolicy(["launcher"]),
  "atbroker.exe": nativePolicy(["launcher"]),
  "bash.exe": nativePolicy(["launcher"]),
  "bcp.exe": nativePolicy(["network"]),
  "bginfo.exe": nativePolicy(["launcher"]),
  "bitsadmin.exe": { ...nativePolicy(["launcher", "network"]), sink: /\/upload(?:\s|$)/i },
  "cdb.exe": nativePolicy(["launcher"]),
  "certoc.exe": nativePolicy(["launcher", "network"]),
  "certreq.exe": nativePolicy(["network"]),
  "certutil.exe": { ...nativePolicy(["read", "network"]), sink: /-urlcache(?:\s|$)/i },
  "change.exe": nativePolicy(["launcher"]),
  "cl_invocation.ps1": nativePolicy(["launcher"]),
  "cl_loadassembly.ps1": nativePolicy(["launcher"]),
  "cl_mutexverifiers.ps1": nativePolicy(["launcher"]),
  "cmd.exe": nativePolicy(["launcher", "network"], "cmd"),
  "cmdkey.exe": { ...nativePolicy(["read"]), credential: true },
  "cmdl32.exe": nativePolicy(["network"]),
  "cmstp.exe": nativePolicy(["launcher"]),
  "configsecuritypolicy.exe": nativePolicy(["network"]),
  "conhost.exe": nativePolicy(["launcher"]),
  "control.exe": nativePolicy(["launcher"]),
  "coregen.exe": nativePolicy(["launcher"]),
  "cscript.exe": nativePolicy(["launcher"]),
  "csi.exe": nativePolicy(["launcher"]),
  "curl.exe": nativePolicy(["network"]),
  "customshellhost.exe": nativePolicy(["launcher"]),
  "datasvcutil.exe": nativePolicy(["network"]),
  "dbgsrv.exe": nativePolicy(["launcher"]),
  "defaultpack.exe": nativePolicy(["launcher"]),
  "desk.cpl": nativePolicy(["launcher"]),
  "desktopimgdownldr.exe": nativePolicy(["network"]),
  "devinit.exe": nativePolicy(["launcher"]),
  "devtoolslauncher.exe": nativePolicy(["launcher"]),
  "devtunnel.exe": nativePolicy(["network"]),
  "diantz.exe": nativePolicy(["launcher", "network"]),
  "diskshadow.exe": nativePolicy(["launcher"]),
  "dnscmd.exe": nativePolicy(["launcher"]),
  "dnx.exe": nativePolicy(["launcher"]),
  "dotnet-counters.exe": nativePolicy(["launcher"]),
  "dotnet-trace.exe": nativePolicy(["launcher"]),
  "dotnet.exe": nativePolicy(["launcher"], "dotnet"),
  "dxcap.exe": nativePolicy(["launcher"]),
  "ecmangen.exe": nativePolicy(["network"]),
  "esentutl.exe": nativePolicy(["network"]),
  "excel.exe": nativePolicy(["network"]),
  "expand.exe": nativePolicy(["network"]),
  "explorer.exe": nativePolicy(["launcher"]),
  "extexport.exe": nativePolicy(["launcher"]),
  "extrac32.exe": nativePolicy(["network"]),
  "findstr.exe": nativePolicy(["network"]),
  "finger.exe": nativePolicy(["network"]),
  "forfiles.exe": nativePolicy(["launcher"]),
  "fsutil.exe": nativePolicy(["launcher"]),
  "ftp.exe": nativePolicy(["launcher", "network"]),
  "gpscript.exe": nativePolicy(["launcher"]),
  "hh.exe": nativePolicy(["launcher", "network"]),
  "ie4uinit.exe": nativePolicy(["launcher"]),
  "ieadvpack.dll": nativePolicy(["launcher"]),
  "iediagcmd.exe": nativePolicy(["launcher"]),
  "ieexec.exe": nativePolicy(["launcher", "network"]),
  "ieframe.dll": nativePolicy(["launcher"]),
  "imewdbld.exe": nativePolicy(["network"]),
  "infdefaultinstall.exe": nativePolicy(["launcher"]),
  "installutil.exe": nativePolicy(["launcher", "network"]),
  "intellitrace.exe": nativePolicy(["launcher"]),
  "launch-vsdevshell.ps1": nativePolicy(["launcher"]),
  "ldifde.exe": nativePolicy(["network"]),
  "logger.exe": nativePolicy(["launcher"]),
  "makecab.exe": nativePolicy(["launcher", "network"]),
  "manage-bde.wsf": nativePolicy(["launcher"]),
  "mavinject.exe": nativePolicy(["launcher"]),
  "mftrace.exe": nativePolicy(["launcher"]),
  "microsoft.nodejstools.pressanykey.exe": nativePolicy(["launcher"]),
  "microsoft.workflow.compiler.exe": nativePolicy(["launcher"]),
  "mmc.exe": nativePolicy(["launcher", "network"]),
  "mofcomp.exe": nativePolicy(["launcher"]),
  "mpcmdrun.exe": nativePolicy(["network"]),
  "mpiexec.exe": nativePolicy(["launcher"]),
  "msaccess.exe": nativePolicy(["network"]),
  "msbuild.exe": nativePolicy(["launcher"]),
  "msconfig.exe": nativePolicy(["launcher"]),
  "mscopilot_proxy.exe": nativePolicy(["launcher"]),
  "mscopilot.exe": nativePolicy(["launcher"]),
  "msdeploy.exe": nativePolicy(["launcher"]),
  "msdt.exe": nativePolicy(["launcher"]),
  "msedge_proxy.exe": nativePolicy(["launcher", "network"]),
  "msedge.exe": nativePolicy(["launcher", "network"]),
  "msedgewebview2.exe": nativePolicy(["launcher"]),
  "mshta.exe": nativePolicy(["launcher", "network"]),
  "mshtml.dll": nativePolicy(["launcher"]),
  "msiexec.exe": nativePolicy(["launcher"]),
  "msohtmed.exe": nativePolicy(["network"]),
  "msoxmled.exe": nativePolicy(["network"]),
  "mspub.exe": nativePolicy(["network"]),
  "msxsl.exe": nativePolicy(["launcher", "network"]),
  "netsh.exe": nativePolicy(["launcher"]),
  "ngen.exe": nativePolicy(["network"]),
  "node.exe": { ...nativePolicy(["launcher"]), aliases: ["node", "nodejs", "nodejs.exe"] },
  "nslookup.exe": nativePolicy(["network"]),
  "ntsd.exe": nativePolicy(["launcher"]),
  "odbcconf.exe": nativePolicy(["launcher"]),
  "offlinescannershell.exe": nativePolicy(["launcher"]),
  "onedrivestandaloneupdater.exe": nativePolicy(["network"]),
  "openconsole.exe": nativePolicy(["launcher"]),
  "outlook.exe": nativePolicy(["network"]),
  "pcalua.exe": nativePolicy(["launcher"]),
  "pcwrun.exe": nativePolicy(["launcher"]),
  "pcwutl.dll": nativePolicy(["launcher"]),
  "pester.bat": nativePolicy(["launcher"]),
  "photoviewer.dll": nativePolicy(["network"]),
  "ping.exe": nativePolicy(["network"]),
  "pixtool.exe": nativePolicy(["launcher"]),
  "pnputil.exe": nativePolicy(["launcher"]),
  "powerpnt.exe": nativePolicy(["network"]),
  "presentationhost.exe": nativePolicy(["launcher", "network"]),
  "printbrm.exe": nativePolicy(["network"]),
  "procdump.exe": nativePolicy(["launcher"]),
  "protocolhandler.exe": nativePolicy(["network"]),
  "provlaunch.exe": nativePolicy(["launcher"]),
  "pubprn.vbs": nativePolicy(["launcher"]),
  "python.exe": { ...nativePolicy(["launcher"]), aliases: ["python", "python2", "python3", "python2.exe", "python3.exe", "pypy", "pypy3", "pypy.exe", "pypy3.exe"] },
  "query.exe": nativePolicy(["launcher"]),
  "rasautou.exe": nativePolicy(["launcher"]),
  "rcsi.exe": nativePolicy(["launcher"]),
  "regasm.exe": nativePolicy(["launcher"]),
  "register-cimprovider.exe": nativePolicy(["launcher"]),
  "regsvcs.exe": nativePolicy(["launcher"]),
  "regsvr32.exe": nativePolicy(["launcher"]),
  "remote.exe": nativePolicy(["launcher"]),
  "replace.exe": nativePolicy(["network"]),
  "reset.exe": nativePolicy(["launcher"]),
  "rundll32.exe": { ...nativePolicy(["launcher"]), credential: /\bkeymgr\.dll\s*,\s*krshowkeymgr\b/i },
  "runexehelper.exe": nativePolicy(["launcher"]),
  "runonce.exe": nativePolicy(["launcher"]),
  "runscripthelper.exe": nativePolicy(["launcher"]),
  "schtasks.exe": nativePolicy(["launcher"]),
  "scp.exe": nativePolicy(["launcher", "network"]),
  "scriptrunner.exe": nativePolicy(["launcher"]),
  "scrobj.dll": nativePolicy(["network"]),
  "setres.exe": nativePolicy(["launcher"]),
  "settingsynchost.exe": nativePolicy(["launcher"]),
  "setupapi.dll": nativePolicy(["launcher"]),
  "setupugc.exe": nativePolicy(["launcher"]),
  "sftp.exe": nativePolicy(["launcher", "network"]),
  "shdocvw.dll": nativePolicy(["launcher"]),
  "shell32.dll": nativePolicy(["launcher"]),
  "shimgvw.dll": nativePolicy(["network"]),
  "sigverif.exe": nativePolicy(["launcher"]),
  "sqlps.exe": nativePolicy(["launcher"]),
  "sqltoolsps.exe": nativePolicy(["launcher"]),
  "squirrel.exe": nativePolicy(["launcher", "network"]),
  "ssh.exe": nativePolicy(["launcher", "network"]),
  "stordiag.exe": nativePolicy(["launcher"]),
  "syncappvpublishingserver.exe": nativePolicy(["launcher"]),
  "syncappvpublishingserver.vbs": nativePolicy(["launcher"]),
  "syssetup.dll": nativePolicy(["launcher"]),
  "te.exe": nativePolicy(["launcher"]),
  "teams.exe": nativePolicy(["launcher"]),
  "testwindowremoteagent.exe": nativePolicy(["network"]),
  "tftp.exe": nativePolicy(["network"]),
  "tracker.exe": nativePolicy(["launcher"]),
  "ttdinject.exe": nativePolicy(["launcher"]),
  "tttracer.exe": nativePolicy(["launcher"]),
  "unregmp2.exe": nativePolicy(["launcher"]),
  "update.exe": nativePolicy(["launcher", "network"]),
  "url.dll": nativePolicy(["launcher"]),
  "utilityfunctions.ps1": nativePolicy(["launcher"]),
  "verclsid.exe": nativePolicy(["launcher"]),
  "visio.exe": nativePolicy(["network"]),
  "vsdiagnostics.exe": nativePolicy(["launcher"]),
  "vshadow.exe": nativePolicy(["launcher"]),
  "vsiisexelauncher.exe": nativePolicy(["launcher"]),
  "vsjitdebugger.exe": nativePolicy(["launcher"]),
  "vslaunchbrowser.exe": nativePolicy(["launcher", "network"]),
  "vsls-agent.exe": nativePolicy(["launcher"]),
  "wab.exe": nativePolicy(["launcher"]),
  "wbemtest.exe": nativePolicy(["launcher"]),
  "wfmformat.exe": nativePolicy(["launcher"]),
  "vaultcmd.exe": { ...nativePolicy(["read"]), credential: true },
  "wget.exe": nativePolicy(["network"]),
  "windbg.exe": nativePolicy(["launcher"]),
  "winfile.exe": nativePolicy(["launcher"]),
  "winget.exe": nativePolicy(["launcher", "network"]),
  "winproj.exe": nativePolicy(["network"]),
  "winrm.vbs": nativePolicy(["launcher"]),
  "winword.exe": nativePolicy(["network"]),
  "wlrmdr.exe": nativePolicy(["launcher"]),
  "wmic.exe": nativePolicy(["launcher"], "wmic"),
  "workfolders.exe": nativePolicy(["launcher"]),
  "write.exe": nativePolicy(["launcher"]),
  "wsb.exe": nativePolicy(["launcher"]),
  "wscript.exe": nativePolicy(["launcher"]),
  "wsl.exe": nativePolicy(["launcher", "network"]),
  "wt.exe": nativePolicy(["launcher"]),
  "wuauclt.exe": nativePolicy(["launcher"]),
  "xbootmgr.exe": nativePolicy(["launcher"]),
  "xbootmgrsleep.exe": nativePolicy(["launcher"]),
  "xsd.exe": nativePolicy(["network"]),
  "xwizard.exe": nativePolicy(["launcher", "network"]),
  "zipfldr.dll": nativePolicy(["launcher"]),
  "invoke-webrequest": { aliases: ["iwr", "curl", "wget"], effects: ["network"], parameters: HTTP_PARAMETERS },
  "invoke-restmethod": { aliases: ["irm"], effects: ["network"], parameters: HTTP_PARAMETERS },
  "get-content": { aliases: ["gc", "cat", "type"], effects: ["read"], parameters: [...PATH_PARAMETERS, "raw?", "encoding", "totalcount", "tail", "delimiter", "wait?"] },
  "get-item": { aliases: ["gi"], effects: ["read", "variable-read"], parameters: PATH_PARAMETERS },
  "get-childitem": { aliases: ["gci", "dir", "ls"], effects: ["read"], parameters: [...PATH_PARAMETERS, "recurse?", "name?", "file?", "directory?", "depth"] },
  "select-string": { aliases: ["sls"], effects: ["read"], parameters: [...PATH_PARAMETERS, "pattern", "inputobject", "raw?", "simplematch?", "casesensitive?", "quiet?", "list?"] },
  "import-clixml": { aliases: [], effects: ["read"], parameters: ["path", "literalpath", "skip", "first"] },
  "import-csv": { aliases: ["ipcsv"], effects: ["read"], parameters: ["path", "literalpath", "delimiter", "header", "encoding", "useculture?"] },
  "format-hex": { aliases: ["fhx"], effects: ["read"], parameters: ["path", "literalpath", "inputobject", "encoding", "count", "offset"] },
  "get-secret": { aliases: [], effects: ["read"], credential: true, parameters: ["name", "vault", "asplaintext?"] },
  "get-storedcredential": { aliases: [], effects: ["read"], credential: true, parameters: ["target", "ascredentialobject?"] },
  "get-variable": { aliases: ["gv"], effects: ["variable-read"], parameters: ["name", "scope", "valueonly?", "include", "exclude"] },
  "set-variable": { aliases: ["sv", "set"], effects: ["variable-write"], parameters: VARIABLE_PARAMETERS },
  "new-variable": { aliases: ["nv"], effects: ["variable-write"], parameters: VARIABLE_PARAMETERS },
  "clear-variable": { aliases: ["clv"], effects: ["variable-write"], parameters: ["name", "scope", "force?", "include", "exclude"] },
  "remove-variable": { aliases: ["rv"], effects: ["variable-write"], parameters: ["name", "scope", "force?", "include", "exclude"] },
  "set-item": { aliases: ["si"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "new-item": { aliases: ["ni"], effects: ["provider-write", "file-write"], destination: CONTENT_DESTINATION, parameters: ITEM_PARAMETERS },
  "clear-item": { aliases: ["cli"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "remove-item": { aliases: ["ri", "rm", "rmdir", "rd", "del", "erase"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "copy-item": { aliases: ["cpi", "cp", "copy"], effects: ["provider-write", "file-write"], destination: COPY_DESTINATION, parameters: [...ITEM_PARAMETERS, "tosession", "fromsession", "container?"] },
  "move-item": { aliases: ["mi", "mv", "move"], effects: ["provider-write", "file-write"], destination: COPY_DESTINATION, parameters: ITEM_PARAMETERS },
  "rename-item": { aliases: ["rni", "ren"], effects: ["provider-write", "dispatch"], destination: { parameters: ["newname"], position: 1 }, parameters: [...ITEM_PARAMETERS, "newname"] },
  "set-content": { aliases: ["sc"], effects: ["provider-write", "file-write"], destination: CONTENT_DESTINATION, parameters: [...ITEM_PARAMETERS, "encoding", "nonewline?"] },
  "add-content": { aliases: ["ac"], effects: ["provider-write", "file-write"], destination: CONTENT_DESTINATION, parameters: [...ITEM_PARAMETERS, "encoding", "nonewline?"] },
  "out-file": { aliases: [], effects: ["file-write"], destination: { parameters: ["filepath", "literalpath"], position: 0 }, parameters: ["filepath", "literalpath", "inputobject", "encoding", "append?", "force?", "noclobber?", "width", "nonewline?"] },
  "out-printer": { aliases: ["lp"], effects: ["network", "file-write"], destination: { parameters: ["name"], position: 0, kind: "printer" }, parameters: ["name", "inputobject"] },
  "export-pfxcertificate": { aliases: [], effects: ["read", "file-write"], credential: true, parameters: ["cert", "filepath", "password", "chainoption", "cryptoprotectto*", "force?", "noclobber?"] },
  "export-csv": { aliases: ["epcsv"], effects: ["file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "literalpath", "inputobject", "delimiter", "encoding", "append?", "force?", "noclobber?", "notypeinformation?", "useculture?"] },
  "export-clixml": { aliases: [], effects: ["file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "literalpath", "inputobject", "depth", "encoding", "force?", "noclobber?"] },
  "export-alias": { aliases: ["epal"], effects: ["file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "literalpath", "name", "scope", "description", "as", "append?", "force?", "noclobber?"] },
  "export-pssession": { aliases: ["epsn"], effects: ["network", "file-write"], destination: CONTENT_DESTINATION, parameters: ["path", "session", "commandname*", "commandtype*", "module*", "allowclobber?", "force?", "encoding"] },
  "clear-content": { aliases: ["clc"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "set-itemproperty": { aliases: ["sp"], effects: ["provider-write"], parameters: ITEM_PARAMETERS },
  "get-itemproperty": { aliases: ["gp"], effects: ["read", "variable-read"], parameters: ITEM_PARAMETERS },
  "get-itempropertyvalue": { aliases: ["gpv"], effects: ["read", "variable-read"], parameters: ITEM_PARAMETERS },
  "start-bitstransfer": { aliases: [], effects: ["network"], parameters: ["source", "destination", "transfertype", "credential", "asynchronous?", "displayname", "description"] },
  "send-mailmessage": { aliases: [], effects: ["network"], destination: { parameters: ["smtpserver"], kind: "mail" }, parameters: ["to", "from", "subject", "smtpserver", "body", "attachments", "credential", "port", "usessl?", "bodyashtml?", "cc", "bcc"] },
  "resolve-dnsname": { aliases: [], effects: ["network"], parameters: ["name", "server", "type", "dnsonly?", "quicktimeout?"] },
  "test-netconnection": { aliases: ["tnc"], effects: ["network"], parameters: ["computername", "port", "informationlevel", "traceroute?", "hops"] },
  "test-connection": { aliases: [], effects: ["network"], parameters: ["computername", "targetname", "count", "quiet?", "timeoutseconds"] },
  "new-pssession": { aliases: ["nsn"], effects: ["network"], parameters: ["computername", "connectionuri", "credential", "name", "port", "usessl?"] },
  "enter-pssession": { aliases: ["etsn"], effects: ["network"], parameters: ["computername", "connectionuri", "credential", "session", "id", "name"] },
  "invoke-command": { aliases: ["icm"], effects: ["network", "launcher"], parameters: ["computername", "connectionuri", "credential", "session", "scriptblock", "filepath", "argumentlist*", "asjob?"] },
  "new-webserviceproxy": { aliases: [], effects: ["network"], parameters: ["uri", "credential", "namespace", "class"] },
  "start-process": { aliases: ["saps", "start"], effects: ["launcher"], parameters: ["filepath", "argumentlist*", "workingdirectory", "credential", "wait?", "nonewwindow?", "passthru?", "verb", "windowstyle"] },
  "invoke-item": { aliases: ["ii"], effects: ["launcher"], parameters: PATH_PARAMETERS },
  "invoke-expression": { aliases: ["iex"], effects: ["launcher"], parameters: ["command*"] },
  "start-job": { aliases: ["sajb"], effects: ["launcher"], parameters: ["scriptblock", "filepath", "name", "argumentlist*"] },
  "start-threadjob": { aliases: [], effects: ["launcher"], parameters: ["scriptblock", "filepath", "name", "argumentlist*", "initializationscript", "streaminghost", "throttlelimit"] },
  "start-scheduledtask": { aliases: [], effects: ["launcher"], parameters: ["taskname", "taskpath", "inputobject", "cimsession", "asjob?", "throttlelimit"] },
  "register-scheduledtask": { aliases: [], effects: ["launcher"], parameters: ["taskname", "taskpath", "action", "trigger", "settings", "principal", "user", "password", "xml", "inputobject", "cimsession", "asjob?", "force?"] },
  "new-scheduledtaskaction": { aliases: [], effects: ["launcher"], parameters: ["execute", "argument", "workingdirectory", "id", "cimsession", "asjob?"] },
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
  "set-clipboard": { aliases: ["scb"], effects: ["local"], parameters: ["value*", "append?", "passthru?", "asosc52?"] },
  "test-path": { aliases: [], effects: ["local"], parameters: [...PATH_PARAMETERS, "pathtype", "isvalid?", "newerthan", "olderthan"] },
  "set-location": { aliases: ["cd", "chdir", "sl"], effects: ["cwd-write"], parameters: ["path", "literalpath", "passthru?", "stackname"] },
  "push-location": { aliases: ["pushd"], effects: ["cwd-write"], parameters: ["path", "literalpath", "passthru?", "stackname"] },
  "pop-location": { aliases: ["popd"], effects: ["cwd-write"], parameters: ["passthru?", "stackname"] },
  "out-string": { aliases: [], effects: ["local"], parameters: ["inputobject", "width", "stream?"] },
  "get-date": { aliases: [], effects: ["local"], parameters: ["date", "format", "uformat"] },
  "join-path": { aliases: [], effects: ["local"], parameters: ["path", "childpath", "additionalchildpath*", "resolve?"] },
  "expand-archive": { aliases: [], effects: ["local"], destination: { parameters: ["destinationpath"], position: 1 }, parameters: ["path", "literalpath", "destinationpath", "force?", "passthru?"] },
  "tee-object": { aliases: ["tee"], effects: ["file-write"], destination: { parameters: ["filepath", "literalpath"], position: 0, variableParameters: ["variable"] }, parameters: ["filepath", "literalpath", "inputobject", "variable", "append?"] },
  "copy.exe": { aliases: [], effects: ["file-write"], destination: { parameters: [], position: 1 }, parameters: [] },
  "xcopy": { aliases: ["xcopy.exe"], effects: ["file-write"], destination: { parameters: [], position: 1 }, parameters: [] },
  "robocopy": { aliases: ["robocopy.exe"], effects: ["file-write"], destination: { parameters: [], position: 1 }, parameters: [] },
  "tar": { aliases: ["tar.exe"], effects: ["file-write"], parameters: [] },
  "unzip": { aliases: ["unzip.exe"], effects: ["file-write"], parameters: [] },
  "7z": { aliases: ["7z.exe", "7za", "7za.exe", "7zr", "7zr.exe"], effects: ["file-write"], parameters: [] },
  "new-object": { aliases: [], effects: ["launcher"], parameters: ["typename", "argumentlist*", "comobject", "property"] },
} satisfies Record<string, PowerShellCommandPolicy>));

function powerShellCommandSpellings(name: string): string[] {
  const policy = POWERSHELL_COMMAND_POLICIES[name];
  return [name, ...(policy?.native && name.endsWith(".exe") ? [name.slice(0, -4)] : []), ...(policy?.aliases ?? [])];
}

const commandAliases = new Map(Object.keys(POWERSHELL_COMMAND_POLICIES).flatMap((name) =>
  powerShellCommandSpellings(name).map((alias) => [alias, name] as const)));

export function canonicalPowerShellName(text: string): string {
  // Effect classification reads the selected command leaf; exact rule identity retains the original qualification separately.
  const name = text.slice(Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/")) + 1).toLowerCase();
  return commandAliases.get(name) ?? name;
}

export function powerShellCommandsWithEffect(effect: PowerShellCommandPolicy["effects"][number]): Set<string> {
  return new Set(Object.entries(POWERSHELL_COMMAND_POLICIES).filter(([, policy]) => policy.effects.includes(effect)).map(([name]) => name));
}

export const POWERSHELL_ANALYSIS_LIMITS = Object.freeze({ inputChars: 8_000, depth: 16, expressionDepth: 24 });

export class PowerShellStructuralLimitError extends Error {}

// Structural recursion is bounded independently of machine load.
export class PowerShellAnalysisContext {
  limited = false;
  readonly visits = { frames: 0, stages: 0, lexes: 0, views: 0, values: 0, dataFacts: 0, embeddedCodeCalls: 0, obligationNodes: 0, obligationVisits: 0, obligationItems: 0,
    staticTokens: 0, staticArguments: 0, staticChars: 0, staticNodes: 0, grammarRecords: 0, recordScanChars: 0 };
  private frameDepth = 0;
  readonly facts = new Map<string, unknown>();

  enter(source: string): void {
    this.visits.frames += 1;
    if (source.length > POWERSHELL_ANALYSIS_LIMITS.inputChars || this.frameDepth >= POWERSHELL_ANALYSIS_LIMITS.depth) this.exceed();
    this.frameDepth += 1;
  }
  leave(): void { this.frameDepth -= 1; }
  currentFrameDepth(): number { return this.frameDepth; }
  requireAdditionalFrameDepth(additional: number): void {
    if (this.frameDepth + additional > POWERSHELL_ANALYSIS_LIMITS.depth) this.exceed();
  }
  private exceed(): never { this.limited = true; throw new PowerShellStructuralLimitError("PowerShell structural limit exceeded"); }
}

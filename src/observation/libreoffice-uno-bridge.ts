/** Fixed private-pipe client. Requests select admitted data and export formats, never executable code. */
export const DOCUMENT_ENGINE_UNO_BRIDGE = String.raw`import json
import os
import re
import sys
import time
import uno
import unohelper
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException
from com.sun.star.task import XInteractionHandler

def require(condition):
    if not condition:
        raise RuntimeError("Invalid private document engine request.")

def property_value(name, value):
    result = PropertyValue()
    result.Name = name
    result.Value = value
    return result

def load_properties(interaction):
    return [property_value("Hidden", True), property_value("ReadOnly", True),
        property_value("MacroExecutionMode", uno.Any("short", uno.getConstantByName("com.sun.star.document.MacroExecMode.NEVER_EXECUTE"))),
        property_value("UpdateDocMode", uno.Any("short", uno.getConstantByName("com.sun.star.document.UpdateDocMode.NO_UPDATE"))),
        property_value("InteractionHandler", interaction)]

class RefuseInteraction(unohelper.Base, XInteractionHandler):
    def __init__(self):
        self.requested = False

    def handle(self, request):
        self.requested = True
        for continuation in request.getContinuations():
            if continuation.queryInterface(uno.getTypeByName("com.sun.star.task.XInteractionAbort")):
                continuation.select()
                return
        raise RuntimeError("Document requires unsupported interaction.")

require(len(sys.argv) == 2)
request_path = sys.argv[1]
descriptor = os.open(request_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
with os.fdopen(descriptor, "rb") as stream:
    raw = stream.read(16385)
require(len(raw) <= 16384)
request = json.loads(raw.decode("utf-8"))
require(isinstance(request, dict) and request.get("version") == 1)
operation = request.get("operation")
common = {"version", "operation", "pipeName", "connectionTimeoutMs", "pollMs"}
require(operation in ("ready", "convert"))
require(set(request) == (common if operation == "ready" else common | {"source", "outputDirectory", "format"}))
pipe_name = request["pipeName"]
require(isinstance(pipe_name, str) and re.fullmatch(r"ave_[a-f0-9]{32}", pipe_name))
timeout = request["connectionTimeoutMs"]
poll = request["pollMs"]
require(type(timeout) is int and timeout > 0 and type(poll) is int and poll > 0)
local = uno.getComponentContext()
resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
deadline = time.monotonic() + timeout / 1000.0
while True:
    try:
        context = resolver.resolve("uno:pipe,name=" + pipe_name + ";urp;StarOffice.ComponentContext")
        break
    except NoConnectException:
        if time.monotonic() >= deadline:
            raise RuntimeError("Private document engine connection timed out.")
        time.sleep(poll / 1000.0)
desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
require(desktop is not None)
if operation == "ready":
    if not desktop.getComponents().hasElements():
        interaction = RefuseInteraction()
        blank = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0,
            tuple(load_properties(interaction)))
        require(blank is not None and not interaction.requested)
    require(desktop.getComponents().hasElements())
    print(json.dumps({"version": 1, "ready": True}), flush=True)
    sys.exit(0)

source = request["source"]
output = request["outputDirectory"]
format_name = request["format"]
require(format_name in ("docx", "odt", "pptx", "xlsx", "ods", "hwp", "hwpx"))
require(isinstance(source, str) and os.path.isabs(source) and os.path.realpath(source) == source and not os.path.islink(source))
require(isinstance(output, str) and os.path.isabs(output) and os.path.realpath(output) == output and os.path.isdir(output))
stem, extension = os.path.splitext(os.path.basename(source))
require(re.fullmatch(r"[a-f0-9-]{36}", stem) and extension == "." + format_name)
interaction = RefuseInteraction()
load = load_properties(interaction)
if format_name in ("hwp", "hwpx"):
    load.append(property_value("FilterName", "Hwp2002_File"))
document = desktop.loadComponentFromURL(uno.systemPathToFileUrl(source), "_blank", 0, tuple(load))
require(document is not None)
try:
    if interaction.requested:
        raise RuntimeError("Document requires unsupported interaction.")
    def export(extension_name, filter_name):
        target = os.path.join(output, stem + "." + extension_name)
        require(not os.path.lexists(target))
        document.storeToURL(uno.systemPathToFileUrl(target),
            (property_value("FilterName", filter_name), property_value("Overwrite", False),
             property_value("InteractionHandler", interaction)))
        require(not interaction.requested)
    if format_name in ("xlsx", "ods"):
        require(document.supportsService("com.sun.star.sheet.SpreadsheetDocument"))
        document.enableAutomaticCalculation(True)
        document.calculateAll()
        require(not interaction.requested)
        export(format_name, "Calc MS Excel 2007 XML" if format_name == "xlsx" else "calc8")
    else:
        export("pdf", "impress_pdf_Export" if format_name == "pptx" else "writer_pdf_Export")
        if format_name in ("hwp", "hwpx"):
            export("odt", "writer8")
    require(not interaction.requested)
finally:
    document.close(True)
print(json.dumps({"version": 1, "converted": True}), flush=True)
`;

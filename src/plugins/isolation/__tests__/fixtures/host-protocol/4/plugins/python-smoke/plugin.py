"""The cross-language smoke plugin (plugin-hostapi-protocol.md §9.7 P5).

A `process` plugin in Python that owns its stdin and stdout: one
newline-delimited JSON-RPC loop. `ave/instance/*` requests go to the handlers
below, replies to its own `ave/host/*` requests settle its pending table, and
every other request is first held to MCP's per-request metadata and then handed
to the stock `mcp` server kernel in memory, one message at a time. No stock
stdio driver runs: each would claim the process's stdin and stdout. Anything
this program logs goes to stderr; stdout carries frames only.
"""

import base64
import errno
import json
import os
import resource
import socket
import sys

PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion"
CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"
RAW_RESULT_META = "ave/rawResult"
HOST_PROTOCOL_VERSION = "4"
REQUIRED_HOST_METHODS = ["ave/host/storage/read", "ave/host/storage/write"]
STATE_KEY = "smoke/state.bin"
INVALID_PARAMS = -32602
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


def log(text):
    print(f"[python-smoke] {text}", file=sys.stderr, flush=True)


if sys.argv[1:] == ["--print-mcp-origin"]:
    import mcp

    print(mcp.__file__)
    sys.exit(0)

import anyio  # noqa: E402 - after the origin probe, which imports nothing else
from mcp import types  # noqa: E402
from mcp.server.lowlevel import Server  # noqa: E402
from mcp.shared.message import SessionMessage  # noqa: E402


def write_frame(frame):
    sys.stdout.buffer.write(json.dumps(frame, separators=(",", ":")).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def error_frame(frame_id, code, message, data=None):
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": frame_id, "error": error}


class HostRequestError(Exception):
    pass


TOOLS = [
    types.Tool(
        name="echo",
        description="Answer with the arguments it was called with.",
        input_schema={"type": "object", "properties": {}},
    ),
    # Admission's escapes 1 and 2 (plugin-hostapi-protocol.md §9.8 A2), from a
    # child that is not JavaScript: the filesystem and the raw network claims
    # are the substrate's, so they are re-proven here under the same wrap. They
    # report every answer; the confined suite asserts them.
    types.Tool(
        name="escape_secrets",
        description="Write and read back its own data directory, then read the host's secrets directory and another plugin's data directory.",
        input_schema={
            "type": "object",
            "properties": {
                "ownDataDir": {"type": "string"},
                "secretsDir": {"type": "string"},
                "otherDataDir": {"type": "string"},
                "sentinelName": {"type": "string"},
            },
            "required": ["ownDataDir", "secretsDir", "otherDataDir", "sentinelName"],
        },
    ),
    types.Tool(
        name="escape_network",
        description="Open a raw socket to a loopback listener.",
        input_schema={
            "type": "object",
            "properties": {"port": {"type": "number"}},
            "required": ["port"],
        },
    ),
]
TOOL_NAMES = [tool.name for tool in TOOLS]
ESCAPE_TIMEOUT_S = 5
OWN_BYTES = "the python-smoke plugin's own bytes"


def attempt(probe):
    """A probe's answer: its value, or the errno name the platform refused it with."""
    try:
        return {"ok": True, "value": probe()}
    except OSError as error:
        code = errno.errorcode.get(error.errno) if error.errno else None
        return {"ok": False, "code": code or type(error).__name__}


def read_text(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def connect(port):
    with socket.create_connection(("127.0.0.1", port), timeout=ESCAPE_TIMEOUT_S):
        return "connected"


def run_tool(name, arguments):
    if name == "echo":
        return {"echoed": arguments}
    if name == "escape_secrets":
        secrets_dir = arguments["secretsDir"]
        other_dir = arguments["otherDataDir"]
        sentinel = arguments["sentinelName"]
        own_file = os.path.join(arguments["ownDataDir"], sentinel)
        return {
            "attempt": "escape_secrets",
            # The in-sandbox control: its own data directory, written and read
            # back, so the refusals below are not a wrong path's ENOENT.
            "own": {
                "write": attempt(lambda: write_text(own_file, OWN_BYTES)),
                "read": attempt(lambda: read_text(own_file)),
            },
            "filesystem": {
                "listSecrets": attempt(lambda: sorted(os.listdir(secrets_dir))),
                "readSecret": attempt(lambda: read_text(os.path.join(secrets_dir, sentinel))),
                "listOtherData": attempt(lambda: sorted(os.listdir(other_dir))),
                "readOtherData": attempt(lambda: read_text(os.path.join(other_dir, sentinel))),
            },
        }
    if name == "escape_network":
        return {"attempt": "escape_network", "raw": {"connect": attempt(lambda: connect(int(arguments["port"])))}}
    raise ValueError(f"no tool named {name!r}")


async def list_tools(_ctx, _params):
    return types.ListToolsResult(tools=TOOLS)


async def call_tool(_ctx, params):
    result = run_tool(params.name, params.arguments or {})
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(result, sort_keys=True))],
        _meta={RAW_RESULT_META: result},
    )


class Plugin:
    def __init__(self, kernel_input):
        self.capabilities = None
        self.next_id = 0
        self.host_pending = {}
        self.kernel_input = kernel_input
        self.kernel_pending = {}
        self.kernel_turn = anyio.Lock()

    # -- the host half: ave/host/* requests this plugin sends ----------------

    async def host_request(self, method, params):
        if method not in (self.capabilities or []):
            raise HostRequestError(f"the host did not advertise {method}")
        self.next_id += 1
        request_id = self.next_id
        settled = anyio.Event()
        self.host_pending[request_id] = [settled, None]
        write_frame({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        await settled.wait()
        reply = self.host_pending.pop(request_id)[1]
        if "error" in reply:
            raise HostRequestError(f"{method} answered {reply['error']}")
        return reply.get("result")

    def settle_host_reply(self, frame):
        entry = self.host_pending.get(frame.get("id"))
        if entry is None:
            log(f"a reply to no request of ours: {frame.get('id')!r}")
            return
        entry[1] = frame
        entry[0].set()

    # -- the instance half: ave/instance/* requests the host sends -----------

    async def construct(self, params):
        version = (params.get("hostProtocol") or {}).get("version")
        if version != HOST_PROTOCOL_VERSION:
            raise ProtocolMismatch(version)
        self.capabilities = list(params["hostProtocol"].get("capabilities") or [])
        return {
            "implementedToolNames": TOOL_NAMES,
            "servesUiResources": False,
            "lifecycleHooks": ["start", "stop"],
            "pluginProtocol": {"requires": REQUIRED_HOST_METHODS},
        }

    async def start(self, _params):
        stored = base64.b64encode(b"python-smoke").decode("ascii")
        await self.host_request(
            "ave/host/storage/write", {"relPath": STATE_KEY, "data": {"encoding": "base64", "data": stored}}
        )
        read = await self.host_request("ave/host/storage/read", {"relPath": STATE_KEY})
        self.notify_log("python-smoke started", {"read": read})
        return None

    async def stop(self, _params):
        self.notify_log("python-smoke stopping", {"ruMaxrss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
        return None

    def notify_log(self, message, meta):
        write_frame({"jsonrpc": "2.0", "method": "notifications/ave/log", "params": {"message": message, "meta": meta}})

    # -- the MCP half: everything else, through the stock kernel --------------

    async def serve_mcp(self, frame):
        meta = (frame.get("params") or {}).get("_meta")
        if not isinstance(meta, dict) or PROTOCOL_VERSION_META not in meta or CLIENT_CAPABILITIES_META not in meta:
            write_frame(
                error_frame(
                    frame["id"],
                    INVALID_PARAMS,
                    f"{frame['method']} lacks _meta {PROTOCOL_VERSION_META!r} or {CLIENT_CAPABILITIES_META!r}",
                )
            )
            return
        async with self.kernel_turn:
            answered = anyio.Event()
            self.kernel_pending[frame["id"]] = answered
            await self.kernel_input.send(SessionMessage(types.jsonrpc_message_adapter.validate_python(frame)))
            await answered.wait()

    async def forward_kernel_output(self, kernel_output):
        async for message in kernel_output:
            frame = message.message.model_dump(by_alias=True, exclude_unset=True, mode="json")
            write_frame(frame)
            answered = self.kernel_pending.pop(frame.get("id"), None)
            if answered is not None:
                answered.set()

    # -- the loop ------------------------------------------------------------

    async def handle_request(self, frame):
        method = frame["method"]
        handlers = {
            "ave/instance/construct": self.construct,
            "ave/instance/start": self.start,
            "ave/instance/stop": self.stop,
        }
        if not method.startswith("ave/"):
            await self.serve_mcp(frame)
            return
        handler = handlers.get(method)
        if handler is None:
            write_frame(error_frame(frame["id"], METHOD_NOT_FOUND, f"{method} is not served by this plugin"))
            return
        try:
            result = await handler(frame.get("params") or {})
        except ProtocolMismatch as mismatch:
            write_frame(
                error_frame(
                    frame["id"],
                    INTERNAL_ERROR,
                    f"host protocol {mismatch.version} is not one this plugin serves ({HOST_PROTOCOL_VERSION})",
                    {"code": "protocol-version-mismatch", "detail": {"served": [HOST_PROTOCOL_VERSION], "version": mismatch.version}},
                )
            )
            return
        except HostRequestError as failure:
            write_frame(error_frame(frame["id"], INTERNAL_ERROR, str(failure)))
            return
        write_frame({"jsonrpc": "2.0", "id": frame["id"], "result": result})


class ProtocolMismatch(Exception):
    def __init__(self, version):
        super().__init__(version)
        self.version = version


async def main():
    server = Server("python-smoke", version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool)
    kernel_input, kernel_read = anyio.create_memory_object_stream(0)
    kernel_write, kernel_output = anyio.create_memory_object_stream(0)
    plugin = Plugin(kernel_input)
    stdin = anyio.wrap_file(sys.stdin.buffer)
    async with anyio.create_task_group() as tasks:
        tasks.start_soon(server.run, kernel_read, kernel_write, server.create_initialization_options())
        tasks.start_soon(plugin.forward_kernel_output, kernel_output)
        async for line in stdin:
            try:
                frame = json.loads(line)
            except ValueError:
                log(f"dropped a line that is not JSON: {line[:80]!r}")
                continue
            if not isinstance(frame, dict):
                log("dropped a frame that is not an object")
            elif "method" in frame and "id" in frame:
                tasks.start_soon(plugin.handle_request, frame)
            elif "method" not in frame and "id" in frame:
                plugin.settle_host_reply(frame)
        # stdin ended: the host is gone, so this process leaves on its own.
        log("stdin ended")
        tasks.cancel_scope.cancel()


if __name__ == "__main__":
    anyio.run(main)

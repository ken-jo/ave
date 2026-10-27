"""Patch existing ordinary cells without serializing unrelated package XML."""

import argparse
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import xml.parsers.expat as expat
from xml.sax.saxutils import escape, quoteattr
import zipfile

BACKUP_BYTES = 8 * 1024 * 1024
MAX_BYTES = 20 * 1024 * 1024
MAX_EXPANDED_BYTES = 200 * 1024 * 1024
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
TYPE_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
WORKBOOK_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"


def require(condition, message):
    if not condition:
        raise ValueError(message)


class Element:
    def __init__(self, name, attrs, start, head_end, raw):
        self.name, self.attrs = name, attrs
        self.start, self.head_end = start, head_end
        self.end = head_end
        self.close_start = head_end
        self.empty = raw[start:head_end].rstrip().endswith(b"/>")
        self.children = []


def xml_tree(raw):
    raw.decode("utf-8", errors="strict")
    declaration = re.match(rb"(?:\xef\xbb\xbf)?<\?xml\s[^?]*\?>", raw)
    if declaration:
        encoding = re.search(rb"\bencoding\s*=\s*['\"]([^'\"]+)['\"]", declaration.group(0))
        require(encoding is None or encoding.group(1).lower() == b"utf-8", "Only UTF-8 XML is supported.")
    require(b"<!DOCTYPE" not in raw.upper() and b"<!ENTITY" not in raw.upper(), "XML declarations are unsupported.")
    parser = expat.ParserCreate(namespace_separator="|")
    stack, roots = [], []

    def start(name, attrs):
        pos = parser.CurrentByteIndex
        # Attribute values may contain '>'; consume the opening tag with quotes bound.
        end, quote = pos, None
        while end < len(raw):
            char = raw[end]
            if quote:
                if char == quote:
                    quote = None
            elif char in (34, 39):
                quote = char
            elif char == 62:
                break
            end += 1
        element = Element(name, attrs, pos, end + 1, raw)
        (stack[-1].children if stack else roots).append(element)
        stack.append(element)

    def end(_name):
        element = stack.pop()
        if not element.empty:
            element.close_start = parser.CurrentByteIndex
            element.end = raw.index(b">", element.close_start) + 1

    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.Parse(raw, True)
    require(len(roots) == 1, "XML must have one root.")
    return roots[0]


def children(element, local, namespace=MAIN_NS):
    return [child for child in element.children if child.name == namespace + "|" + local]


def walk(element):
    yield element
    for child in element.children:
        yield from walk(child)


def patch(raw, replacements):
    for start, end, replacement in sorted(replacements, reverse=True):
        raw = raw[:start] + replacement + raw[end:]
    xml_tree(raw)
    return raw


def qualified(raw, element, local):
    name = re.match(rb"<([^\s/>]+)", raw[element.start:element.head_end]).group(1)
    prefix = name.rsplit(b":", 1)[0] + b":" if b":" in name else b""
    return (prefix + local.encode()).decode()


def opening_with(raw, element, attributes):
    head = raw[element.start:element.head_end].decode()
    for key, value in attributes.items():
        pattern = r"\s" + re.escape(key) + r"\s*=\s*(?:\"[^\"]*\"|'[^']*')"
        head = re.sub(pattern, "", head)
        end = head.rfind("/>") if element.empty else head.rfind(">")
        head = head[:end] + " " + key + "=" + quoteattr(value) + head[end:]
    return head.encode()


def cell_xml(raw, cell, edit):
    require(set(cell.attrs) <= {"r", "s", "t"}, "Cell metadata cannot be safely replaced.")
    require(all(child.name in {MAIN_NS + "|" + n for n in ("f", "v", "is")} for child in cell.children),
            "Cell extensions cannot be safely replaced.")
    tag = qualified(raw, cell, "c")
    prefix = tag[:-1]
    attrs = " r=" + quoteattr(cell.attrs["r"])
    # Namespace declarations are not ordinary attributes in namespace-aware parsing.
    head = raw[cell.start:cell.head_end].decode()
    for declaration in re.finditer(r"\sxmlns(?::[A-Za-z_][\w.-]*)?\s*=\s*(?:\"[^\"]*\"|'[^']*')", head):
        attrs += declaration.group(0)
    if "s" in cell.attrs:
        attrs += " s=" + quoteattr(cell.attrs["s"])
    if "formula" in edit:
        formula = edit["formula"]
        require(isinstance(formula, str) and 0 < len(formula) <= 8192, "Invalid formula.")
        require(not formula.startswith("="), "Formulas omit the leading equals sign.")
        content = f"<{prefix}f>{xml_text(formula)}</{prefix}f>"
    else:
        value = edit["value"]
        if value is None:
            content = ""
        elif isinstance(value, bool):
            attrs += ' t="b"'
            content = f"<{prefix}v>{int(value)}</{prefix}v>"
        elif isinstance(value, (int, float)):
            require(math.isfinite(value) and abs(value) <= 1.7976931348623157e308, "Invalid numeric value.")
            content = f"<{prefix}v>{value}</{prefix}v>"
        else:
            require(isinstance(value, str) and len(value) <= 32767, "Invalid cell value.")
            attrs += ' t="inlineStr"'
            # Preserve literal escape-like strings in the spreadsheet text encoding.
            text = re.sub(r"_x[0-9a-fA-F]{4}_", lambda m: "_x005F_" + m.group(0)[1:], value)
            content = f'<{prefix}is><{prefix}t xml:space="preserve">{xml_text(text)}</{prefix}t></{prefix}is>'
    return f"<{tag}{attrs}>{content}</{tag}>".encode()


def xml_text(text):
    require(all(c in "\t\n\r" or 0x20 <= ord(c) <= 0xD7FF or 0xE000 <= ord(c) <= 0xFFFD
                or 0x10000 <= ord(c) <= 0x10FFFF for c in text), "Unsupported XML character.")
    return escape(text).replace("\r", "&#13;")


def read_package(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        require(0 < len(infos) <= 10000 and len({i.filename.casefold() for i in infos}) == len(infos), "Ambiguous ZIP members.")
        require(sum(i.file_size for i in infos) <= MAX_EXPANDED_BYTES, "Workbook expansion exceeds the limit.")
        parts = {}
        for info in infos:
            name = info.filename
            require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "Unsupported or encrypted ZIP.")
            require(not name.startswith("/") and "\\" not in name and ".." not in PurePosixPath(name).parts, "Unsafe ZIP path.")
            require(not stat.S_ISLNK(info.external_attr >> 16), "Linked ZIP member.")
            require(not name.lower().startswith("_xmlsignatures/") and not name.lower().endswith("vbaproject.bin"), "Signed or macro workbook is unsupported.")
            require(info.file_size < 1024 * 1024 or info.file_size <= max(1, info.compress_size) * 200, "ZIP expansion ratio exceeds the limit.")
            with archive.open(info) as member:
                content = member.read(min(info.file_size + 1, MAX_EXPANDED_BYTES + 1))
            require(len(content) == info.file_size, "Invalid ZIP member length.")
            parts[name] = content
        return parts, infos, archive.comment


def edit_package(data, request):
    require(isinstance(request, dict) and set(request) == {"sheet", "edits"}, "Expected sheet and edits only.")
    sheet_index, edits = request["sheet"], request["edits"]
    require(type(sheet_index) is int and sheet_index >= 0, "Invalid sheet index.")
    require(isinstance(edits, list) and 0 < len(edits) <= 500, "Expected 1 to 500 edits.")
    parts, infos, comment = read_package(data)
    types_raw = parts["[Content_Types].xml"]
    types = xml_tree(types_raw)
    require(types.name == TYPE_NS + "|Types", "Invalid content types.")
    overrides = children(types, "Override", TYPE_NS)
    require(len({c.attrs.get("PartName") for c in overrides}) == len(overrides), "Duplicate content type declaration.")
    require(any(c.attrs.get("PartName") == "/xl/workbook.xml" and c.attrs.get("ContentType") == WORKBOOK_TYPE for c in overrides), "Only ordinary XLSX workbooks are supported.")
    require(not any("macroEnabled" in c.attrs.get("ContentType", "") or "digital-signature" in c.attrs.get("ContentType", "") for c in overrides), "Signed or macro workbook is unsupported.")
    root_rels = children(xml_tree(parts["_rels/.rels"]), "Relationship", PACKAGE_NS)
    office_rels = [r for r in root_rels if r.attrs.get("Type") == REL_NS + "/officeDocument"]
    require(len(office_rels) == 1 and office_rels[0].attrs.get("Target", "").lstrip("/") == "xl/workbook.xml"
            and office_rels[0].attrs.get("TargetMode", "Internal") == "Internal", "Invalid workbook relationship.")
    workbook_raw = parts["xl/workbook.xml"]
    workbook = xml_tree(workbook_raw)
    require(workbook.name == MAIN_NS + "|workbook", "Unsupported workbook namespace.")
    sheets = children(workbook, "sheets")
    require(len(sheets) == 1 and sheet_index < len(children(sheets[0], "sheet")), "Sheet does not exist.")
    selected = children(sheets[0], "sheet")[sheet_index]
    rels_raw = parts["xl/_rels/workbook.xml.rels"]
    rels = xml_tree(rels_raw)
    relationships = children(rels, "Relationship", PACKAGE_NS)
    require(len({r.attrs.get("Id") for r in relationships}) == len(relationships), "Duplicate workbook relationship.")
    matches = [r for r in relationships if r.attrs.get("Id") == selected.attrs.get(REL_NS + "|id")]
    require(len(matches) == 1, "Ambiguous sheet relationship.")
    relationship = matches[0].attrs
    target = relationship.get("Target", "")
    require(relationship.get("Type") == REL_NS + "/worksheet" and relationship.get("TargetMode", "Internal") == "Internal", "Unsupported sheet relationship.")
    sheet_path = target.lstrip("/") if target.startswith("/") else "xl/" + target
    require(re.fullmatch(r"xl/worksheets/[^/]+\.xml", sheet_path), "Unsupported sheet path.")
    raw = parts[sheet_path]
    sheet = xml_tree(raw)
    require(sheet.name == MAIN_NS + "|worksheet", "Unsupported sheet namespace.")
    require(not children(sheet, "sheetProtection") and not children(sheet, "tableParts"), "Protected or table-managed sheets cannot be safely edited.")
    for node in walk(sheet):
        if node.name == MAIN_NS + "|f":
            require(not node.attrs, "Shared, array or data-table formulas cannot be safely edited.")
    rows = children(sheet, "sheetData")
    require(len(rows) == 1, "Expected one sheetData element.")
    cells = {}
    for row in children(rows[0], "row"):
        for cell in children(row, "c"):
            address = cell.attrs.get("r")
            require(address not in cells, "Duplicate cell address.")
            cells[address] = cell
    replacements, seen = [], set()
    for edit in edits:
        require(isinstance(edit, dict) and (set(edit) == {"cell", "value"} or set(edit) == {"cell", "formula"}), "Expected cell and exactly one value or formula.")
        address = edit["cell"]
        require(isinstance(address, str) and re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", address) and address in cells and address not in seen, "Edit requires a unique existing cell address.")
        seen.add(address)
        for merged in children(sheet, "mergeCells"):
            for region in children(merged, "mergeCell"):
                require(not address_in_range(address, region.attrs.get("ref", "")), "Merged cells cannot be safely edited.")
        cell = cells[address]
        replacements.append((cell.start, cell.end, cell_xml(raw, cell, edit)))
    parts[sheet_path] = patch(raw, replacements)
    retained = {node.attrs.get("r") for node in walk(xml_tree(parts[sheet_path])) if node.name == MAIN_NS + "|c"}
    require(set(cells) == retained, "Edited cell namespace or identity changed.")
    calc = children(workbook, "calcPr")
    require(len(calc) <= 1, "Ambiguous calculation properties.")
    attributes = {"fullCalcOnLoad": "1", "forceFullCalc": "1", "calcCompleted": "0", "calcMode": "auto"}
    if calc:
        node = calc[0]
        parts["xl/workbook.xml"] = patch(workbook_raw, [(node.start, node.head_end, opening_with(workbook_raw, node, attributes))])
    else:
        # calcPr precedes these optional trailing workbook children in the schema.
        trailing = {MAIN_NS + "|" + n for n in ("oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst")}
        position = next((n.start for n in workbook.children if n.name in trailing), workbook.close_start)
        tag = qualified(workbook_raw, workbook, "calcPr")
        content = ("<" + tag + " " + " ".join(k + "=" + quoteattr(v) for k, v in attributes.items()) + "/>").encode()
        parts["xl/workbook.xml"] = patch(workbook_raw, [(position, position, content)])
    # A removed or replaced formula must not leave an obsolete calculation-chain entry.
    chain_rels = [r for r in relationships if r.attrs.get("Type") == REL_NS + "/calcChain"]
    chain_paths = set()
    for rel in chain_rels:
        target = rel.attrs.get("Target", "")
        path = target.lstrip("/") if target.startswith("/") else "xl/" + target
        require(path == "xl/calcChain.xml" and rel.attrs.get("TargetMode", "Internal") == "Internal", "Unsupported calculation chain.")
        chain_paths.add(path)
    require("xl/calcChain.xml" not in parts or "xl/calcChain.xml" in chain_paths, "Unlinked calculation chain.")
    if chain_rels:
        parts["xl/_rels/workbook.xml.rels"] = patch(rels_raw, [(r.start, r.end, b"") for r in chain_rels])
        parts["[Content_Types].xml"] = patch(types_raw, [(c.start, c.end, b"") for c in overrides if c.attrs.get("PartName", "").lstrip("/") in chain_paths])
        for path in chain_paths:
            parts.pop(path, None)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", allowZip64=False) as archive:
        archive.comment = comment
        for info in infos:
            if info.filename in parts:
                archive.writestr(info, parts[info.filename])
    result = output.getvalue()
    require(len(result) <= MAX_BYTES, "Edited workbook exceeds the file limit.")
    checked, _, _ = read_package(result)
    require(checked == parts, "Output package validation failed.")
    return result


def address_in_range(address, region):
    def coordinates(value):
        match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", value)
        require(match is not None, "Invalid merged-cell range.")
        column = 0
        for letter in match[1]:
            column = column * 26 + ord(letter) - 64
        return column, int(match[2])
    ends = region.split(":")
    require(len(ends) in (1, 2), "Invalid merged-cell range.")
    first, last, cell = coordinates(ends[0]), coordinates(ends[-1]), coordinates(address)
    return first[0] <= cell[0] <= last[0] and first[1] <= cell[1] <= last[1]


def edit_file(path, request):
    path = Path(path).absolute()
    require(path.suffix.lower() == ".xlsx", "Only .xlsx files can be edited.")
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "Workbook must be a regular unlinked file.")
    require(before.st_size <= MAX_BYTES, "Workbook exceeds 20 MiB.")
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode, info.st_nlink)
    with path.open("rb") as source:
        require(identity(os.fstat(source.fileno())) == identity(before), "Workbook changed before reading.")
        data = source.read(MAX_BYTES + 1)
    require(len(data) == before.st_size, "Workbook changed while reading.")
    output = edit_package(data, request)
    backup = None
    temporary = None
    try:
        if len(data) > BACKUP_BYTES:
            backup = str(path) + ".ave-bak"
            # Exclusive creation preserves previous recovery copies and refuses links.
            with open(backup, "xb") as saved:
                os.chmod(backup, 0o600)
                saved.write(data)
                saved.flush()
                os.fsync(saved.fileno())
            require(Path(backup).read_bytes() == data, "Backup verification failed.")
        descriptor, temporary = tempfile.mkstemp(prefix=".ave-xlsx-", suffix=".tmp", dir=path.parent)
        with os.fdopen(descriptor, "wb") as staged:
            staged.write(output)
            staged.flush()
            os.fsync(staged.fileno())
        require(identity(path.lstat()) == identity(before) and path.read_bytes() == data, "Workbook changed before replacement.")
        os.chmod(temporary, stat.S_IMODE(before.st_mode))
        os.replace(temporary, path)
        temporary = None
        return {"editedCells": len(request["edits"]), "needsRecalculation": True, "backup": backup}
    finally:
        if temporary is not None:
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook")
    parser.add_argument("request", help="UTF-8 JSON with a zero-based sheet and edits")
    args = parser.parse_args()
    try:
        with open(args.request, encoding="utf-8") as source:
            request = json.load(source)
        print(json.dumps(edit_file(args.workbook, request)))
    except (ValueError, OSError, KeyError, expat.ExpatError, zipfile.BadZipFile, RuntimeError) as error:
        print("XLSX edit refused: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Lori-owned offline document operations. Existing OOXML edits preserve other parts.

CLI: python3 "$LORI_DOCUMENT_HELPER" request.json
request: {"action":"replace_text", "path":"input.docx", "outputPath":"out.docx", ...}
All paths are relative to the job workspace. No downloads, plugins or macros.
"""
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

MAX_EXPANDED = 128 * 1024 * 1024
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main"}


def local(root, value):
    if not isinstance(value, str) or "\\" in value or ":" in value or ".." in Path(value).parts:
        raise ValueError("Use a relative job path")
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Path leaves the job workspace")
    return path


def package(path):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(e.file_size for e in entries) > MAX_EXPANDED:
            raise ValueError("Document archive exceeds the expansion limit")
        names = [e.filename for e in entries]
        if len(set(names)) != len(names):
            raise ValueError("Duplicate document archive entries")
        if any(e.flag_bits & 1 or e.filename.startswith(("/", "\\")) or ".." in Path(e.filename.replace("\\", "/")).parts or "vbaproject" in e.filename.lower() for e in entries):
            raise ValueError("Encrypted, macro-enabled or unsafe archives are unsupported")
        parts = {e.filename: archive.read(e) for e in entries}
        main = {".docx":"word/document.xml", ".xlsx":"xl/workbook.xml", ".pptx":"ppt/presentation.xml"}.get(path.suffix.lower())
        if main and any(name not in parts for name in ("[Content_Types].xml", "_rels/.rels", main)):
            raise ValueError("Document is missing required OOXML package parts")
        return parts


def xml(data):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("Document XML entities are unsupported")
    return ET.fromstring(data)


def texts(element, ns):
    return "".join(t.text or "" for t in element.iter() if t.tag in ("{" + ns + "}t", "{" + ns + "}delText"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(root, args):
    path = local(root, args["path"])
    ext = path.suffix.lower()
    result = {"path": args["path"], "sha256": digest(path), "format": ext.lstrip("."), "warnings": [], "blocks": []}
    blocks = result["blocks"]
    if ext in (".docx", ".xlsx", ".pptx"):
        parts = package(path)
        result["parts"] = [{"name": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in parts.items()][:10000]
        if ext == ".docx":
            for name in parts:
                if name == "word/document.xml" or re.fullmatch(r"word/(header\d+|footer\d+|footnotes|endnotes|comments)\.xml", name):
                    tree = xml(parts[name])
                    for i, p in enumerate(tree.iter("{" + NS["w"] + "}p")):
                        blocks.append({"id": f"{name}:p:{i}", "part": name, "kind": "paragraph", "text": texts(p, NS["w"]),
                                       "style": next((e.get("{" + NS["w"] + "}val") for e in p.iter("{" + NS["w"] + "}pStyle")), None)})
                    if any(e.tag in ("{" + NS["w"] + "}ins", "{" + NS["w"] + "}del") for e in tree.iter()):
                        result["warnings"].append("Contains tracked changes; preserve or explicitly resolve revisions.")
            result["outline"] = [{"id": b["id"], "text": b["text"]} for b in blocks if (b.get("style") or "").lower().startswith("heading")]
        elif ext == ".pptx":
            for name in sorted(parts, key=lambda n: (int(re.search(r"(\d+)\.xml$", n).group(1)) if re.search(r"(\d+)\.xml$", n) else 0, n)):
                if re.fullmatch(r"ppt/(slides/slide\d+|notesSlides/notesSlide\d+)\.xml", name):
                    tree = xml(parts[name])
                    for i, p in enumerate(tree.iter("{" + NS["a"] + "}p")):
                        blocks.append({"id": f"{name}:p:{i}", "part": name, "kind": "notes" if "notesSlides" in name else "slideText", "text": texts(p, NS["a"])})
            result["slideCount"] = sum(bool(re.fullmatch(r"ppt/slides/slide\d+\.xml", n)) for n in parts)
        else:
            import openpyxl
            book = openpyxl.load_workbook(path, read_only=True, data_only=False, keep_links=False)
            try:
                result["sheets"] = [{"name": s.title, "rows": s.max_row, "columns": s.max_column} for s in book]
                sheet = book[args.get("sheet") or book.sheetnames[0]]
                start = max(1, args.get("startRow", 1))
                cached = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_links=False)
                try:
                    row_args = dict(min_row=start, max_row=min(sheet.max_row, start + min(args.get("limit", 100), 200) - 1), max_col=min(sheet.max_column, 50))
                    for row, cached_row in zip(sheet.iter_rows(**row_args), cached[sheet.title].iter_rows(**row_args)):
                        for cell, cached_cell in zip(row, cached_row):
                            if cell.value is not None:
                                value = cell.value.isoformat() if hasattr(cell.value, "isoformat") else cell.value
                                cv = cached_cell.value
                                blocks.append({"id": f"{sheet.title}!{cell.coordinate}", "kind": "cell", "cell": cell.coordinate, "sheet": sheet.title, "value": value, "text": str(value), "cachedValue": cv.isoformat() if hasattr(cv, "isoformat") else cv})
                finally:
                    cached.close()
                result["nextRow"] = start + min(args.get("limit", 100), 200) if start + min(args.get("limit", 100), 200) <= sheet.max_row else None
            finally:
                book.close()
            if any(n.startswith("xl/drawings/") for n in parts):
                result["warnings"].append("Drawing parts must be preserved during edits; avoid unrestricted openpyxl round trips.")
    elif ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        if reader.is_encrypted:
            raise ValueError("Encrypted PDFs are unsupported")
        form = reader.trailer["/Root"].get("/AcroForm")
        if form and form.get_object().get("/XFA"):
            result["warnings"].append("XFA forms are unsupported for editing.")
        result["totalPages"] = len(reader.pages)
        result["fields"] = {name: {"type": str(field.get("/FT", "")), "value": str(field.get("/V", ""))} for name, field in (reader.get_fields() or {}).items()}
        start = max(0, args.get("startPage", 1) - 1)
        stop = min(len(reader.pages), start + min(args.get("limit", 10), 30))
        for i in range(start, stop):
            page = reader.pages[i]
            # Bound decompressed content before the text parser allocates additional state.
            content = page.get_contents()
            if content and len(content.get_data()) > 16 * 1024 * 1024:
                raise ValueError("PDF page content exceeds the extraction limit")
            text = page.extract_text() or ""
            blocks.append({"id": f"page:{i+1}", "kind": "page", "page": i + 1, "text": text[:64000], "ocrRequired": not text.strip()})
        result["nextPage"] = stop + 1 if stop < len(reader.pages) else None
    elif ext in (".txt", ".md", ".csv", ".tsv"):
        text = path.read_text(encoding="utf-8")
        blocks.append({"id": "text", "kind": "text", "text": text[:64000]})
    elif ext in (".doc", ".xls", ".ppt", ".odt", ".ods", ".odp"):
        result["warnings"].append("Legacy Office input: use convert_document to create a supported modern copy before editing.")
    elif ext in (".png", ".jpg", ".jpeg", ".webp"):
        from PIL import Image
        with Image.open(path) as image:
            if image.width * image.height > 25000000:
                raise ValueError("Image exceeds the pixel limit")
            image.verify()
        result["warnings"].append("Image preview; document text is available through OCR.")
    else:
        raise ValueError("Unsupported document format; convert to DOCX, XLSX, PPTX, PDF or UTF-8 text")
    offset = max(0, args.get("offset", 0))
    total = len(blocks)
    result["blocks"] = blocks[offset:offset + 200]
    result["nextOffset"] = offset + 200 if offset + 200 < total else None
    result["totalBlocks"] = total
    return result


def validate(root, args):
    result = inspect(root, args)
    result.pop("parts", None)
    result.pop("blocks", None)
    result["integrity"] = "passed"
    result["visualReview"] = "notReviewed"
    result["checks"] = ["File reopened successfully", "Format and archive boundaries checked"]
    path = local(root, args["path"])
    if path.suffix.lower() in (".docx", ".xlsx", ".pptx"):
        import posixpath
        from urllib.parse import unquote
        parts = package(path)
        for name, data in parts.items():
            if name.endswith(".xml") or name.endswith(".rels"):
                tree = xml(data)
                if name.endswith(".rels"):
                    base = posixpath.dirname(posixpath.dirname(name))
                    ids = set()
                    for relation in tree:
                        rid = relation.get("Id")
                        if rid in ids:
                            raise ValueError("Duplicate package relationship IDs")
                        ids.add(rid)
                        if relation.get("TargetMode") == "External":
                            continue
                        target = unquote(relation.get("Target", "").split("#")[0])
                        target = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(base, target))
                        if target.startswith("../") or target not in parts:
                            raise ValueError("Broken internal package relationship: " + name)
        result["checks"].append("Package XML and internal relationships checked")
        if args.get("sourcePath"):
            source_parts = package(local(root, args["sourcePath"]))
            missing = sorted(set(source_parts) - set(parts) - {"xl/calcChain.xml"})
            if missing:
                raise ValueError("Existing package parts were dropped: " + ", ".join(missing[:20]))
            changed = [name for name in source_parts if name in parts and source_parts[name] != parts[name]]
            result["preservation"] = {"retainedParts": len(source_parts), "changedParts": changed[:200]}
            result["checks"].append("Original package parts retained")


    path = local(root, args["path"])
    if path.suffix.lower() == ".xlsx":
        parts = package(path)
        errors, missing, visited = [], [], 0
        ns = "{" + NS["s"] + "}"
        for name, data in parts.items():
            if not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name):
                continue
            for cell in xml(data).iter(ns + "c"):
                visited += 1
                if visited > 1000000:
                    raise ValueError("Workbook validation exceeds one million populated cells")
                address = name + "!" + cell.get("r", "?")
                if cell.get("t") == "e":
                    errors.append(address)
                if cell.find(ns + "f") is not None and (cell.find(ns + "v") is None or (cell.find(ns + "v").text is None and cell.get("t") not in ("str", "inlineStr"))):
                    missing.append(address)
        result["formulaCaches"] = "errors" if errors else "missing" if missing else "checked"
        if errors:
            result["warnings"].append("Formula error cells: " + ", ".join(errors[:20]))
        if missing:
            result["warnings"].append("Formula caches need recalculation: " + ", ".join(missing[:20]))
        result["checks"].append("Formula errors and populated-cell caches checked")
    expected = args.get("expectedText", [])
    if expected:
        evidence = inspect(root, args)
        text = "\n".join(b.get("text", "") for b in evidence["blocks"])
        if evidence.get("nextOffset") or evidence.get("nextPage"):
            raise ValueError("Expected-text check needs a smaller fully inspected range")
        if any(t not in text for t in expected):
            raise ValueError("Requested content is missing from the output")
        result["checks"].append("Expected content matched")
    return result


def save_package(parts, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)


def replace_text(parts, args, ext):
    name = args.get("part", "word/document.xml" if ext == ".docx" else "ppt/slides/slide1.xml")
    pattern = r"word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml" if ext == ".docx" else r"ppt/(slides/slide\d+|notesSlides/notesSlide\d+)\.xml"
    if not re.fullmatch(pattern, name) or name not in parts:
        raise ValueError("Choose an inspected, editable text part")
    from lxml import etree
    tree = etree.fromstring(parts[name], etree.XMLParser(resolve_entities=False, no_network=True))
    namespace = NS["w"] if ext == ".docx" else NS["a"]
    old, new = args["oldText"], args["newText"]
    matches = []
    for p in tree.iter("{" + namespace + "}p"):
        nodes = list(p.iter("{" + namespace + "}t"))
        text = "".join(n.text or "" for n in nodes)
        if old and old in text:
            matches.append((p, nodes, text))
    if len(matches) != 1 or matches[0][2].count(old) != 1:
        raise ValueError("Replacement requires one exact match; inspect a smaller target")
    p, nodes, text = matches[0]
    if ext == ".docx" and any(e.tag in ("{"+namespace+"}ins", "{"+namespace+"}del") for e in p.iter()):
        raise ValueError("Resolve revisions in this paragraph before replacing its text")
    start, stop = text.index(old), text.index(old) + len(old)
    position, inserted = 0, False
    for node in nodes:
        current = node.text or ""
        end = position + len(current)
        if end > start and position < stop:
            prefix = current[:max(0, start-position)]
            suffix = current[max(0, stop-position):] if stop < end else ""
            node.text = prefix + (new if not inserted else "") + suffix
            node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            inserted = True
        position = end
    parts[name] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)


def edit_cells(parts, args):
    name = args.get("part", "xl/worksheets/sheet1.xml")
    if not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name) or name not in parts:
        raise ValueError("Choose an inspected worksheet part")
    from lxml import etree
    tree = etree.fromstring(parts[name], etree.XMLParser(resolve_entities=False, no_network=True))
    ns = "{" + NS["s"] + "}"
    data = tree.find(ns + "sheetData")
    if data is None:
        raise ValueError("Worksheet has no sheetData")
    from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries
    protected = [range_boundaries(f.get("ref")) for f in tree.iter(ns + "f") if f.get("t") in ("array", "shared") and f.get("ref")]
    for address, value in args["cells"].items():
        if not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", address):
            raise ValueError("Invalid cell address")
        row_number = re.search(r"\d+", address).group()
        row_index, column_index = coordinate_to_tuple(address)
        if row_index > 1048576 or column_index > 16384:
            raise ValueError("Cell exceeds Excel row or column bounds")
        if any(left <= column_index <= right and top <= row_index <= bottom for left, top, right, bottom in protected):
            raise ValueError("Shared/array formula ranges require an explicit workbook-aware edit")
        row = next((r for r in data if r.get("r") == row_number), None)
        if row is None:
            raise ValueError("Adding new worksheet rows requires an explicit workbook rebuild")
        cell = next((c for c in row if c.get("r") == address), None)
        if cell is not None and any(f.get("t") in ("array", "shared") for f in cell if f.tag == ns + "f"):
            raise ValueError("Shared/array formulas require an explicit workbook-aware edit")
        if cell is None:
            cell = etree.Element(ns + "c", r=address)
            index = next((i for i, other in enumerate(row) if other.tag != ns + "c" or coordinate_to_tuple(other.get("r"))[1] > column_index), len(row))
            row.insert(index, cell)
        for child in list(cell):
            if child.tag in (ns + "f", ns + "v", ns + "is"):
                cell.remove(child)
        cell.attrib.pop("t", None)
        if isinstance(value, str) and value.startswith("="):
            etree.SubElement(cell, ns + "f").text = value[1:]
        elif isinstance(value, bool):
            cell.set("t", "b")
            etree.SubElement(cell, ns + "v").text = "1" if value else "0"
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            if not math.isfinite(value):
                raise ValueError("Cell numbers must be finite")
            etree.SubElement(cell, ns + "v").text = str(value)
        elif value is not None:
            cell.set("t", "inlineStr")
            etree.SubElement(etree.SubElement(cell, ns + "is"), ns + "t").text = str(value)
    parts[name] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
    parts.pop("xl/calcChain.xml", None)
    # Keep package relationships intact: a stale calculation chain is removed with its declarations.
    for name, data in list(parts.items()):
        if name == "[Content_Types].xml" or name.endswith(".rels"):
            t = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
            removed = False
            for e in list(t):
                if "calcChain" in (e.get("PartName", "") + e.get("Target", "") + e.get("Type", "")):
                    t.remove(e)
                    removed = True
            if removed:
                parts[name] = etree.tostring(t, xml_declaration=True, encoding="UTF-8", standalone=True)


def review_word(parts, args):
    """Whole-paragraph review operations with explicit OOXML anchors and IDs."""
    from lxml import etree
    from copy import deepcopy
    from datetime import datetime, timezone
    ns = "{" + NS["w"] + "}"
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    tree = etree.fromstring(parts["word/document.xml"], parser)
    matches = [p for p in tree.iter(ns + "p") if texts(p, NS["w"]) == args["oldText"]]
    if len(matches) != 1:
        raise ValueError("Review operations require one exact whole-paragraph match")
    paragraph = matches[0]
    if any(child.tag not in (ns + "pPr", ns + "r") for child in paragraph):
        raise ValueError("This paragraph has existing review anchors or complex content; use a simpler target")
    runs = [r for r in paragraph if r.tag == ns + "r"]
    if not runs or any(child.tag not in (ns + "rPr", ns + "t") for r in runs for child in r):
        raise ValueError("Review operations support plain text paragraphs; preserve complex objects")
    author = args.get("author", "Lori")
    date = datetime.now(timezone.utc).isoformat()
    if args["action"] == "tracked_replace":
        ids = [int(e.get(ns + "id")) for e in tree.iter() if (e.get(ns + "id") or "").isdigit()]
        index = max(ids, default=0) + 1
        deleted = etree.Element(ns + "del", {ns + "id": str(index), ns + "author": author, ns + "date": date})
        for run in runs:
            paragraph.remove(run)
            for node in run.iter(ns + "t"):
                node.tag = ns + "delText"
            deleted.append(run)
        inserted = etree.Element(ns + "ins", {ns + "id": str(index+1), ns + "author": author, ns + "date": date})
        new_run = etree.SubElement(inserted, ns + "r")
        properties = runs[0].find(ns + "rPr")
        if properties is not None:
            new_run.append(deepcopy(properties))
        etree.SubElement(new_run, ns + "t", {"{http://www.w3.org/XML/1998/namespace}space": "preserve"}).text = args["newText"]
        paragraph.extend([deleted, inserted])
    elif args["action"] == "add_comment":
        comments = etree.fromstring(parts["word/comments.xml"], parser) if "word/comments.xml" in parts else etree.Element(ns + "comments", nsmap={"w": NS["w"]})
        index = max([int(c.get(ns + "id")) for c in comments if (c.get(ns + "id") or "").isdigit()], default=-1) + 1
        paragraph.insert(paragraph.index(runs[0]), etree.Element(ns + "commentRangeStart", {ns + "id": str(index)}))
        paragraph.append(etree.Element(ns + "commentRangeEnd", {ns + "id": str(index)}))
        reference = etree.SubElement(paragraph, ns + "r")
        etree.SubElement(reference, ns + "commentReference", {ns + "id": str(index)})
        comment = etree.SubElement(comments, ns + "comment", {ns + "id": str(index), ns + "author": author, ns + "date": date})
        etree.SubElement(etree.SubElement(etree.SubElement(comment, ns + "p"), ns + "r"), ns + "t").text = args["text"]
        parts["word/comments.xml"] = etree.tostring(comments, xml_declaration=True, encoding="UTF-8", standalone=True)
        relns = "http://schemas.openxmlformats.org/package/2006/relationships"
        name = "word/_rels/document.xml.rels"
        rels = etree.fromstring(parts[name], parser) if name in parts else etree.Element("{" + relns + "}Relationships", nsmap={None: relns})
        if not any(r.get("Type", "").endswith("/comments") for r in rels):
            identifiers = {r.get("Id") for r in rels}
            rid = "rIdLoriComments"
            while rid in identifiers: rid += "x"
            etree.SubElement(rels, "{" + relns + "}Relationship", Id=rid, Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments", Target="comments.xml")
            parts[name] = etree.tostring(rels, xml_declaration=True, encoding="UTF-8", standalone=True)
        types = etree.fromstring(parts["[Content_Types].xml"], parser)
        if not any(t.get("PartName") == "/word/comments.xml" for t in types):
            etree.SubElement(types, "{http://schemas.openxmlformats.org/package/2006/content-types}Override", PartName="/word/comments.xml", ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml")
            parts["[Content_Types].xml"] = etree.tostring(types, xml_declaration=True, encoding="UTF-8", standalone=True)
    parts["word/document.xml"] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)


def worksheet_parts(parts):
    import posixpath
    ns = "{" + NS["s"] + "}"
    workbook = xml(parts["xl/workbook.xml"])
    rels = xml(parts["xl/_rels/workbook.xml.rels"])
    result = {}
    for sheet in workbook.find(ns + "sheets"):
        rid = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        target = next(r.get("Target") for r in rels if r.get("Id") == rid)
        result[sheet.get("name")] = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
    return result


def recalculate_preserving(source, converted, output):
    """Transplant cached values only; no library round trip of the original package."""
    from lxml import etree
    original, calculated = package(source), package(converted)
    original_sheets, cached_sheets = worksheet_parts(original), worksheet_parts(calculated)
    ns = "{" + NS["s"] + "}"
    def epoch(parts):
        props = xml(parts["xl/workbook.xml"]).find(ns + "workbookPr")
        return props is not None and props.get("date1904") in ("1", "true")
    if epoch(original) != epoch(calculated):
        raise ValueError("Office changed the workbook date epoch; formula caches cannot be transplanted safely")
    shared = [texts(si, NS["s"]) for si in xml(calculated["xl/sharedStrings.xml"])] if "xl/sharedStrings.xml" in calculated else []
    for title, name in original_sheets.items():
        if title not in cached_sheets:
            raise ValueError("Office changed sheet identities")
        cached = {c.get("r"): c for c in xml(calculated[cached_sheets[title]]).iter(ns + "c")}
        tree = etree.fromstring(original[name], etree.XMLParser(resolve_entities=False, no_network=True))
        for cell in tree.iter(ns + "c"):
            if cell.find(ns + "f") is None:
                continue
            calculated_cell = cached.get(cell.get("r"))
            value = calculated_cell.find(ns + "v") if calculated_cell is not None else None
            if value is None or calculated_cell.get("t") == "e":
                raise ValueError("Office did not calculate a supported formula cache")
            kind = calculated_cell.get("t")
            content = value.text or ""
            if kind == "s":
                content = shared[int(content)]
                kind = "str"
            for old in list(cell):
                if old.tag == ns + "v": cell.remove(old)
            if kind in ("str", "b", "d"): cell.set("t", kind)
            else: cell.attrib.pop("t", None)
            etree.SubElement(cell, ns + "v").text = content
        original[name] = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
    save_package(original, output)


def action(root, args, office=None):
    source = local(root, args["path"])
    output = local(root, args["outputPath"])
    if output == source or output.exists():
        raise ValueError("Choose a new output path; original inputs stay unchanged")
    if args.get("expectedHash") and digest(source) != args["expectedHash"]:
        raise ValueError("Source hash changed")
    operation = args["action"]
    ext = source.suffix.lower()
    output.parent.mkdir(parents=True, exist_ok=True)
    if operation == "convert":
        if office is None or output.suffix.lower() not in (".pdf", ".docx", ".xlsx", ".pptx") or ext not in (".doc", ".xls", ".ppt", ".odt", ".ods", ".odp", ".docx", ".xlsx", ".pptx"):
            raise ValueError("Unsupported Office conversion")
        import shutil
        converted = office(root, source, root.parent / "helper-converted", output.suffix[1:])
        shutil.copyfile(converted, output)
    elif operation in ("replace_text", "edit_cells", "tracked_replace", "add_comment"):
        if ext != output.suffix.lower() or ext not in (".docx", ".pptx", ".xlsx"):
            raise ValueError("Use the same supported OOXML format")
        parts = package(source)
        if any(name.startswith("_xmlsignatures/") for name in parts):
            raise ValueError("Signature-preserving Office edits are unsupported")
        if operation == "replace_text" and ext in (".docx", ".pptx"):
            replace_text(parts, args, ext)
        elif operation == "edit_cells" and ext == ".xlsx":
            edit_cells(parts, args)
        elif operation in ("tracked_replace", "add_comment") and ext == ".docx":
            review_word(parts, args)
        else:
            raise ValueError("Operation does not support this format")
        save_package(parts, output)
    elif ext == ".pdf" and output.suffix.lower() == ".pdf":
        pdf_action(source, output, args, root)
    else:
        raise ValueError("Unsupported operation; use the bundled authoring libraries for new documents")
    return {"path": args["outputPath"], "sha256": digest(output), "originalPreserved": True}


def pdf_action(source, output, args, root):
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are unsupported")
    form = reader.trailer["/Root"].get("/AcroForm")
    if form and form.get_object().get("/XFA"):
        raise ValueError("XFA forms are unsupported")
    op = args["action"]
    if any(field.get("/FT") == "/Sig" for field in (reader.get_fields() or {}).values()):
        raise ValueError("Signature-preserving PDF edits are unsupported")
    if op == "redact":
        regions = args.get("regions", [])
        if not regions or any(not isinstance(r.get("page"), int) or not 1 <= r["page"] <= len(reader.pages) for r in regions):
            raise ValueError("Specify valid redaction page regions")
        import pypdfium2 as pdfium
        from PIL import ImageDraw
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        pdf = pdfium.PdfDocument(source)
        writer = canvas.Canvas(str(output))
        try:
            for index in range(len(pdf)):
                page = pdf[index]
                try:
                    width, height = page.get_size()
                    if not all(math.isfinite(x) and x > 0 for x in (width, height)):
                        raise ValueError("PDF raster has invalid dimensions")
                    scale = min(2, 4096 / max(width, height))
                    if math.ceil(width*scale)*math.ceil(height*scale) > 25000000:
                        raise ValueError("PDF raster exceeds safe dimensions")
                    bitmap = page.render(scale=scale)
                    try:
                        image = bitmap.to_pil().convert("RGB")
                        draw = ImageDraw.Draw(image)
                        for region in args.get("regions", []):
                            if region["page"] == index + 1:
                                rect = region["rect"]
                                if len(rect) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in rect) or rect[2] <= rect[0] or rect[3] <= rect[1]:
                                    raise ValueError("Use a normalized rectangle [left, top, right, bottom]")
                                draw.rectangle((rect[0]*image.width, rect[1]*image.height, rect[2]*image.width, rect[3]*image.height), fill="black")
                        writer.setPageSize((width, height))
                        writer.drawImage(ImageReader(image), 0, 0, width=width, height=height)
                        writer.showPage()
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            writer.setAuthor("")
            writer.setTitle("")
            writer.save()
        finally:
            pdf.close()
        return
    writer = PdfWriter()
    if op == "fill_form":
        writer.append(reader)
        values = args["values"]
        known = reader.get_fields() or {}
        if any(name not in known for name in values):
            raise ValueError("Unknown PDF form field")
        for page in writer.pages:
            if page.get("/Annots"):
                writer.update_page_form_field_values(page, values, auto_regenerate=False, flatten=bool(args.get("flatten")))
        if args.get("flatten"):
            writer.remove_annotations(subtypes="/Widget")
            writer._root_object.pop("/AcroForm", None)
    elif op == "merge":
        writer.append(reader)
        for name in args.get("inputs", []):
            other = PdfReader(local(root, name))
            if other.is_encrypted:
                raise ValueError("Encrypted merge inputs are unsupported")
            writer.append(other)
    elif op in ("annotate", "stamp"):
        writer.append(reader)
        number = args.get("page", 1)
        if not isinstance(number, int) or not 1 <= number <= len(reader.pages):
            raise ValueError("Invalid annotation page")
        if op == "annotate":
            from pypdf.annotations import Text
            writer.add_annotation(number-1, Text(rect=args["rect"], text=args["text"]))
        else:
            from reportlab.pdfgen import canvas
            page = writer.pages[number-1]
            stream = io.BytesIO()
            overlay = canvas.Canvas(stream, pagesize=(float(page.mediabox.width), float(page.mediabox.height)))
            overlay.drawString(args.get("x", 30), args.get("y", 30), args["text"])
            overlay.save(); stream.seek(0)
            page.merge_page(PdfReader(stream).pages[0])
    elif op in ("pages", "rotate", "crop"):
        pages = args.get("pages", list(range(1, len(reader.pages) + 1)))
        for number in pages:
            if not isinstance(number, int) or not 1 <= number <= len(reader.pages):
                raise ValueError("Invalid PDF page number")
            page = reader.pages[number-1]
            if op == "rotate":
                degrees = args.get("degrees", 90)
                if degrees % 90:
                    raise ValueError("Rotation must be a multiple of 90 degrees")
                page.rotate(degrees)
            if op == "crop":
                rect = args["rect"]
                if len(rect) != 4 or not all(math.isfinite(v) for v in rect) or rect[2] <= rect[0] or rect[3] <= rect[1]:
                    raise ValueError("Invalid PDF crop rectangle")
                page.cropbox.lower_left = rect[:2]
                page.cropbox.upper_right = rect[2:]
            writer.add_page(page)
    else:
        raise ValueError("Supported PDF actions: pages, merge, rotate, crop, fill_form, annotate, stamp, redact")
    writer.write(output)
    checked = PdfReader(output)
    if op == "fill_form" and not args.get("flatten"):
        actual = checked.get_fields() or {}
        if any(str(actual[name].get("/V", "")) != str(value) for name, value in args["values"].items()):
            raise ValueError("PDF field values did not persist")


if __name__ == "__main__":
    import importlib.util
    spec = importlib.util.spec_from_file_location("lori_worker", Path(__file__).with_name("worker.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    request = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(action(Path.cwd(), request, worker.office), ensure_ascii=False))

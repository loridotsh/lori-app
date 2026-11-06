"""Lori's bundled offline tool worker. All networking is owned by the Rust broker."""
import argparse
import dataclasses
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import zipfile
import importlib.util


def document_helpers():
    spec = importlib.util.spec_from_file_location("lori_document_helpers", Path(__file__).with_name("document_helpers.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

MAX_TEXT = 64000
MAX_DOCUMENT_TEXT = 8 * 1024 * 1024
MAX_IMAGE_BASE64 = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 25000000


def local(root, value):
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Path leaves the working folder")
    return path


def runtime_root():
    return Path(__file__).resolve().parent


def office(root, path, destination, fmt="pdf"):
    runtime = runtime_root()
    candidates = [runtime / "office/program/soffice", runtime / "office/program/soffice.exe", runtime / "office/Contents/MacOS/soffice"]
    executable = next((p for p in candidates if p.is_file()), None)
    if executable is None:
        raise RuntimeError("The bundled Office converter is unavailable")
    profile = root.parent / "office-profile"
    profile.mkdir(exist_ok=True)
    # A dedicated profile never inherits the user's macros, links, or extensions.
    (profile / "user").mkdir(exist_ok=True)
    (profile / "user/registrymodifications.xcu").write_text('''<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>''')
    destination.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, SAL_USE_VCLPLUGIN="svp", SAL_DISABLESKIA="1")
    process = subprocess.run([str(executable), "-env:UserInstallation=" + profile.as_uri(), "-env:OSL_SOCKET_PATH=" + str(root.parent), "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to", fmt, "--outdir", str(destination), str(path)], capture_output=True, timeout=90, env=environment)
    output = destination / (path.stem + "." + fmt.split(":")[0])
    if process.returncode or not output.is_file():
        detail = (process.stderr + process.stdout).decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Office conversion failed ({process.returncode}): " + detail)
    return output


def validate_archive(path):
    if path.suffix.lower() not in (".docx", ".xlsx", ".pptx"):
        return
    document_helpers().package(path)


def ocr(path, root):
    from PIL import Image
    import pytesseract
    runtime = runtime_root()
    executable = runtime / "bin" / ("tesseract.exe" if os.name == "nt" else "tesseract")
    if not executable.is_file():
        raise RuntimeError("The bundled OCR engine is unavailable")
    pytesseract.pytesseract.tesseract_cmd = str(executable)
    os.environ["TESSDATA_PREFIX"] = str(runtime / "tessdata")
    with Image.open(path) as image:
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ValueError("Image exceeds the pixel limit")
        return pytesseract.image_to_string(image, lang="eng", timeout=30)


def read_document(root, args):
    path = local(root, args["path"])
    validate_archive(path)
    ext = path.suffix.lower()
    pages = {}
    if ext == ".docx":
        parts = document_helpers().package(path)
        helper = document_helpers()
        text = "\n".join(helper.texts(p, helper.NS["w"]) for name, data in parts.items() if name == "word/document.xml" or name.startswith(("word/header", "word/footer", "word/footnotes", "word/endnotes", "word/comments")) and name.endswith(".xml") for p in helper.xml(data).iter("{" + helper.NS["w"] + "}p"))
    elif ext == ".xlsx":
        import openpyxl
        book = openpyxl.load_workbook(path, read_only=True, data_only=False, keep_links=False)
        chunks = []
        size = 0
        try:
            for sheet in book:
                if sheet.max_row > 10000 or sheet.max_column > 100:
                    raise ValueError("Worksheet exceeds the supported 10000 row / 100 column extraction range")
                chunks.append("Sheet: " + sheet.title)
                for row in sheet.iter_rows(max_row=min(sheet.max_row, 10000), max_col=min(sheet.max_column, 100)):
                    line = "\t".join(str(cell.value) if cell.value is not None else "" for cell in row)
                    size += len(line) + 1
                    if size > MAX_DOCUMENT_TEXT:
                        raise ValueError("Document text exceeds the 8 MiB extraction limit")
                    chunks.append(line)
            text = "\n".join(chunks)
        finally:
            book.close()
    elif ext == ".pptx":
        from pptx import Presentation
        presentation = Presentation(path)
        text = "\n".join(f"Slide {i + 1}\n" + "\n".join(shape.text for shape in slide.shapes if shape.has_text_frame) for i, slide in enumerate(presentation.slides))
    elif ext == ".pdf":
        import pypdfium2 as pdfium
        chunks = []
        document = pdfium.PdfDocument(path)
        try:
            start = max(0, args.get("startPage", 1) - 1)
            total = len(document)
            if start >= total:
                raise ValueError("startPage exceeds the document page count")
            stop = min(total, start + args.get("limit", 10))
            pages = {"totalPages": total, "startPage": start + 1, "endPage": stop,
                     "nextPage": stop + 1 if stop < total else None,
                     "pagesTruncated": start > 0 or stop < total}
            for index in range(start, stop):
                page = document[index]
                try:
                    textpage = page.get_textpage()
                    try:
                        text = textpage.get_text_range()
                    finally:
                        textpage.close()
                    if not text.strip():
                        scale = 1.5
                        width, height = page.get_size()
                        dimensions = (width * scale, height * scale)
                        if any(not math.isfinite(size) or size <= 0 for size in dimensions):
                            raise ValueError("Document page has invalid dimensions")
                        # PDFium rounds each scaled dimension up before allocating.
                        if math.ceil(dimensions[0]) * math.ceil(dimensions[1]) > MAX_IMAGE_PIXELS:
                            raise ValueError("Document page exceeds the pixel limit")
                        target = root.parent / f"ocr-{index}.png"
                        bitmap = page.render(scale=scale)
                        try:
                            bitmap.to_pil().save(target)
                        finally:
                            bitmap.close()
                        text = ocr(target, root)
                    chunks.append(f"Page {index + 1}\n{text}")
                finally:
                    page.close()
            text = "\n".join(chunks)
        finally:
            document.close()
    elif ext in (".png", ".jpg", ".jpeg", ".webp"):
        text = ocr(path, root)
    else:
        raise ValueError("Unsupported document format")
    if len(text) > MAX_DOCUMENT_TEXT:
        raise ValueError("Document text exceeds the 8 MiB extraction limit")
    offset = args.get("startOffset", 0)
    end = min(len(text), offset + MAX_TEXT)
    return {"path": args["path"], "text": text[offset:end], "startOffset": offset,
            "nextOffset": end if end < len(text) else None, "totalCharacters": len(text),
            "textTruncated": end < len(text),
            "truncated": end < len(text) or pages.get("pagesTruncated", False), **pages}


def recalculate_spreadsheet(root, args):
    root = root.resolve()
    path = local(root, args["path"])
    if path.suffix.lower() != ".xlsx":
        raise ValueError("Spreadsheet recalculation supports XLSX files")
    validate_archive(path)
    destination = local(root, args["outputPath"])
    if destination.suffix.lower() != ".xlsx" or destination == path:
        raise ValueError("Use a different XLSX output path")
    if destination.exists():
        raise ValueError("Recalculation output already exists; choose a new path")
    converted = office(root, path, root.parent / "recalculated", "xlsx:Calc MS Excel 2007 XML")
    validate_archive(converted)
    destination.parent.mkdir(parents=True, exist_ok=True)
    document_helpers().recalculate_preserving(path, converted, destination)
    return {"files": [str(destination.relative_to(root))], "recalculated": True}


def view_image(root, args):
    from PIL import Image
    import base64
    import io
    with Image.open(local(root, args["path"])) as image:
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ValueError("Image exceeds the pixel limit")
        image.thumbnail((1536, 1536))
        image = image.convert("RGB")
        for quality in (85, 75, 60, 45):
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=quality)
            data = base64.b64encode(output.getvalue()).decode()
            if len(data) <= MAX_IMAGE_BASE64:
                return {"image": {"mimeType": "image/jpeg", "data": data}, "path": args["path"]}
        raise ValueError("Image could not fit the vision transport limit")


def render_document(root, args):
    import pypdfium2 as pdfium
    root = root.resolve()
    path = local(root, args["path"])
    validate_archive(path)
    destination = local(root, args["outputDirectory"])
    if path.suffix.lower() not in (".pdf", ".docx", ".xlsx", ".pptx"):
        raise ValueError("This format is not supported by the document renderer")
    destination.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() != ".pdf":
        path = office(root, path, root.parent / "converted")
    document = pdfium.PdfDocument(path)
    files = []
    try:
        start = max(0, args.get("startPage", 1) - 1)
        if start >= len(document):
            raise ValueError("startPage exceeds the document page count")
        stop = min(len(document), start + args.get("limit", 10))
        for index in range(start, stop):
            page = document[index]
            try:
                width, height = page.get_size()
                if not all(math.isfinite(v) and v > 0 for v in (width, height)):
                    raise ValueError("Document page has invalid dimensions")
                scale = min(1.5, 2048 / max(width, height))
                if math.ceil(width * scale) * math.ceil(height * scale) > MAX_IMAGE_PIXELS:
                    raise ValueError("Document page exceeds the pixel limit")
                target = destination / f"page-{index + 1}.png"
                if target.exists():
                    raise ValueError("Preview output already exists; choose a new output directory")
                bitmap = page.render(scale=scale)
                try:
                    bitmap.to_pil().save(target)
                finally:
                    bitmap.close()
                files.append(str(target.relative_to(root)))
            finally:
                page.close()
        total = len(document)
    finally:
        document.close()
    return {"files": files, "totalPages": total, "startPage": start + 1, "endPage": stop, "nextPage": stop + 1 if stop < total else None}


def preview_document(root, args):
    path = local(root, args["path"])
    validate_archive(path)
    destination = local(root, args["outputDirectory"])
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / "preview.pdf"
    if path.suffix.lower() == ".pdf":
        import shutil
        shutil.copyfile(path, target)
    elif path.suffix.lower() in (".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".odt", ".ods", ".odp"):
        import shutil
        shutil.copyfile(office(root, path, root.parent / "converted"), target)
    else:
        raise ValueError("This file does not have a PDF preview")
    return {"files": [str(target.relative_to(root))]}


def search(args):
    # Rust fetches from fixed, validated search endpoints. DDGS parses the
    # returned HTML offline; this worker has no network or user-file access.
    if args["engine"] == "duckduckgo":
        from ddgs.engines.duckduckgo import Duckduckgo
        engine = Duckduckgo()
    elif args["engine"] == "brave":
        from ddgs.engines.brave import Brave
        engine = Brave()
    else:
        raise ValueError("Unsupported search engine")
    results = engine.post_extract_results(engine.extract_results(args["html"]))
    return {"results": [dataclasses.asdict(result) for result in results[:args.get("limit", 5)]], "engine": args["engine"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    request = json.loads(Path(parser.parse_args().request).read_text())
    tool, args = request["tool"], request["arguments"]
    root = Path(request["workspace"]).resolve()
    if sys.platform.startswith("linux"):
        os.environ["LD_LIBRARY_PATH"] = str(runtime_root() / "lib")
    if tool == "web_search":
        result = search(args)
    elif tool == "run_command":
        runtime = runtime_root()
        path = [str(runtime / "python/bin"), str(runtime / "python"), str(runtime / "bin"), str(runtime / "office/program"), str(runtime / "office/Contents/MacOS"), "/usr/bin", "/bin"]
        os.environ["PATH"] = os.pathsep.join(path)
        os.environ["LORI_DOCUMENT_HELPER"] = str(runtime / "document_helpers.py")
        if os.name == "nt":
            command = [str(runtime / "bin/busybox.exe"), "sh", "-c", args["command"]]
        else:
            command = ["/bin/sh", "-c", args["command"]]
        process = subprocess.run(command, cwd=local(root, args.get("cwd", ".")), timeout=min(args.get("timeoutSeconds", 120), 600))
        sys.exit(process.returncode)
    elif tool == "read_document":
        result = read_document(root, args)
    elif tool == "inspect_document":
        result = document_helpers().inspect(root, args)
    elif tool == "validate_document":
        result = document_helpers().validate(root, args)
    elif tool == "convert_document":
        result = document_helpers().action(root, {**args, "action": "convert"}, office)
        result["files"] = [args["outputPath"]]
    elif tool == "preview_document":
        result = preview_document(root, args)
    elif tool == "render_document":
        result = render_document(root, args)
    elif tool == "recalculate_spreadsheet":
        result = recalculate_spreadsheet(root, args)
    elif tool == "view_image":
        result = view_image(root, args)
    else:
        raise ValueError("Unknown worker operation")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)[:2000]}), file=sys.stderr)
        sys.exit(1)

import { describe, expect, it } from "vitest";
import { byteWindow, generatedFileMime } from "./files.js";

describe("byteWindow", () => {
  const MiB = 1024 * 1024;
  it("serves the bytes asked for, within the file", () => {
    expect(byteWindow("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(byteWindow("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteWindow("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });
  it("caps an open-ended request so a paused player never holds a whole file", () => {
    expect(byteWindow("bytes=0-", 200 * MiB)).toEqual({ start: 0, end: 4 * MiB - 1 });
    expect(byteWindow("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
  });
  it("tells an impossible range from no range at all", () => {
    expect(byteWindow("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteWindow("bytes=9-3", 1000)).toBe("unsatisfiable");
    expect(byteWindow("bytes=0-", 0)).toBe("unsatisfiable");
    expect(byteWindow("bytes=-", 1000)).toBeNull();
    expect(byteWindow("items=0-9", 1000)).toBeNull();
    expect(byteWindow(undefined, 1000)).toBeNull();
  });
});

describe("Generated document media types", () => {
  it("recognizes a PDF only with the expected extension and signature", () => {
    expect(generatedFileMime("reports/report.PDF", Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(generatedFileMime("report.pdf", Buffer.from("<html>untrusted</html>"))).toBe("application/octet-stream");
    expect(generatedFileMime("report.html", Buffer.from("%PDF-1.7\n"))).toBe("application/octet-stream");
    expect(generatedFileMime("report.pdf", Buffer.from("%PDF"))).toBe("application/octet-stream");
  });
  it("recognizes rendered PNG pages while leaving unknown formats download-only", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(generatedFileMime("preview/page-1.png", png)).toBe("image/png");
    expect(generatedFileMime("preview/page-1.png", Buffer.from("not PNG"))).toBe("application/octet-stream");
    expect(generatedFileMime("notes.txt", Buffer.from("hello"))).toBe("application/octet-stream");
  });
});

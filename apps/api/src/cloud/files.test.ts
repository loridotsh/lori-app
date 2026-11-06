import { describe, expect, it } from "vitest";
import { generatedFileMime } from "./files.js";

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

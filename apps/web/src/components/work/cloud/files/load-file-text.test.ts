import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudFile } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { loadFileText } from "./load-file-text";

vi.mock("@/lib/cloud-work-api", () => ({ cloudApi: vi.fn() }));
const file = { id: "f", path: "guide.lori.json", version: 2, sha256: "current", sizeBytes: 100 } as CloudFile;
afterEach(() => vi.resetAllMocks());

describe("complete artifact file reads", () => {
  it("joins pages with byte cursors before exposing an editable artifact", async () => {
    vi.mocked(cloudApi).mockResolvedValueOnce({ file, text: '{"version":', truncated: true, nextOffset: 11 })
      .mockResolvedValueOnce({ file, text: "1}", truncated: false, nextOffset: null });
    expect(await loadFileText(file, () => true)).toMatchObject({ text: '{"version":1}', truncated: false });
    expect(vi.mocked(cloudApi).mock.calls[1]?.[0]).toContain("offset=11&limit=1000");
  });
  it.each([{ version: 3 }, { sha256: "changed" }, { id: "other" }])("rejects mixed file revisions: %s", async change => {
    vi.mocked(cloudApi).mockResolvedValueOnce({ file, text: "{", truncated: true, nextOffset: 1 })
      .mockResolvedValueOnce({ file: { ...file, ...change }, text: "}", truncated: false, nextOffset: null });
    await expect(loadFileText(file, () => true)).rejects.toThrow(/changed while loading/);
  });
  it.each([undefined, null, 0, -1, 0.5, 1000000])("rejects a partial result with cursor %s", async nextOffset => {
    vi.mocked(cloudApi).mockResolvedValue({ file, text: "{", truncated: true, nextOffset });
    await expect(loadFileText(file, () => true)).rejects.toThrow(/completely/);
    expect(cloudApi).toHaveBeenCalledOnce();
  });
  it("stops obsolete reads without fetching another page", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ file, text: "{", truncated: true, nextOffset: 1 });
    expect(await loadFileText(file, () => false)).toBeNull();
    expect(cloudApi).toHaveBeenCalledOnce();
  });
  it("bounds UTF-8 content even when the listed size is wrong", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ file, text: "界".repeat(40000), truncated: false });
    await expect(loadFileText(file, () => true)).rejects.toThrow(/limits/);
  });
  it("keeps ordinary text reads partial and does not fetch additional pages", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ file, text: "notes", truncated: true, nextOffset: 5 });
    expect(await loadFileText({ ...file, path: "notes.md" }, () => true)).toMatchObject({ text: "notes", truncated: true });
    expect(cloudApi).toHaveBeenCalledOnce();
  });
});

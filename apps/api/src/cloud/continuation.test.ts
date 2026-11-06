import { describe, expect, it } from "vitest";
import { imageMessage, planningTokens } from "./continuation.js";
import { getCloudTools, modelOutput } from "./tools.js";

describe("Cloud document context", () => {
  it("keeps complete plugin schemas and callable identities inside discovery previews", () => {
    const tools = Array.from({ length: 8 }, (_, i) => ({
      name: `tool_${i}`,
      pluginId: "linear",
      connectionId: "connection",
      connectionRevision: 4,
      schemaHash: "a".repeat(64),
      readOnly: true,
      description: "Read a team",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "文😀".repeat(250) },
        },
        required: ["query"],
      },
    }));
    const output = {
      kind: "plugin_tool_discovery",
      tools,
      resources: [],
      offset: 10,
      nextOffset: 18,
      total: 25,
    };
    for (const budget of [8192, 2048]) {
      const result = modelOutput(output, "receipt", budget) as {
        tools: typeof tools;
        nextOffset: number;
        preview?: string;
      };
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        budget,
      );
      expect(result.preview).toBeUndefined();
      expect(result.nextOffset).toBeGreaterThan(10);
      for (const tool of result.tools)
        expect(tool).toEqual(tools.find((t) => t.name === tool.name));
      if (budget === 8192) expect(result.tools.length).toBeGreaterThan(0);
    }
    expect(output.tools).toHaveLength(8);
  });
  it("directs oversized schemas to the durable result instead of emitting a broken JSON prefix", () => {
    const output = {
      kind: "plugin_tool_discovery",
      tools: [
        { name: "large_tool", inputSchema: { description: "x".repeat(20000) } },
      ],
      resources: [],
      offset: 0,
      nextOffset: null,
      total: 1,
    };
    const result = modelOutput(output, "receipt") as Record<string, unknown>;
    expect(result.tools).toEqual([]);
    expect(result.invocationId).toBe("receipt");
    expect(result.hint).toContain("full schema");
    expect(result.nextOffset).toBeNull();
    expect(result.preview).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
  });
  it("keeps a failed command's hint when its output is too large to return", () => {
    const hint = "Run the command again with output at a relative path.";
    const result = modelOutput(
      { exitCode: 1, stdout: "", stderr: "x".repeat(20000), hint },
      "receipt",
    ) as Record<string, unknown>;
    expect(result.hint).toContain(hint);
    expect(result.hint).toContain("read_tool_output");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
  });
  it("only advertises command execution and binary document support for qualified workers", () => {
    const textOnly = getCloudTools(false);
    expect(textOnly.some((t) => t.name === "run_command")).toBe(false);
    expect(
      textOnly.find((t) => t.name === "read_document")!.description,
    ).toContain("unavailable on this worker");
    const documents = getCloudTools(true);
    expect(
      documents.find((t) => t.name === "read_document")!.description,
    ).toContain("DOCX");
    expect(
      documents.find((t) => t.name === "run_command")!.description,
    ).toContain("inputPaths");
  });
  it("keeps hashes and paging cursors outside truncated text previews", () => {
    const output = {
      path: "report.docx",
      text: "文😀".repeat(10000),
      sha256: "a".repeat(64),
      nextOffset: 10000,
      totalCharacters: 30000,
    };
    const preview = modelOutput(output, "receipt");
    expect(preview).toMatchObject({
      path: output.path,
      sha256: output.sha256,
      nextOffset: 10000,
      invocationId: "receipt",
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(
      8192,
    );
    expect(output.text.length).toBe(30000);
  });
  it("keeps generated-file receipts and command status even when stdout is verbose", () => {
    const changedFiles = [
      {
        path: "reports/report.docx",
        sha256: "b".repeat(64),
        size_bytes: 10000,
      },
    ];
    const output = {
      result: { stdout: "x".repeat(96000), exitCode: 0, stdoutTruncated: true },
      changedFiles,
    };
    const preview = modelOutput(output, "receipt");
    expect(preview).toMatchObject({
      result: { exitCode: 0, stdoutTruncated: true },
      changedFiles,
      changedFilesCount: 1,
      invocationId: "receipt",
    });
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(
      8192,
    );
    const many = modelOutput(
      {
        ...output,
        changedFiles: Array.from({ length: 20 }, (_, i) => ({
          ...changedFiles[0],
          path: `${i}/${"😀".repeat(110)}`,
        })),
      },
      "receipt",
    );
    expect(many).toMatchObject({
      changedFilesCount: 20,
      changedFilesTruncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(8192);
  });
  it("delivers image content natively without putting base64 in a text preview", () => {
    const output = {
      path: "page.png",
      image: { mimeType: "image/jpeg", data: "YWFh".repeat(400000) },
    };
    expect(modelOutput(output, "receipt")).toEqual({
      path: "page.png",
      imageAvailable: true,
    });
    const openai = imageMessage("openai", output)!;
    expect(openai.content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${output.image.data}` },
    });
    expect(imageMessage("anthropic", output)!.content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: output.image.data,
      },
    });
    expect(planningTokens({ messages: [openai] })).toBeGreaterThan(6144);
    expect(planningTokens({ messages: [openai] })).toBeLessThan(6500);
    expect(
      planningTokens({ model: "gpt-4o-mini", messages: [openai] }),
    ).toBeGreaterThan(40000);
  });
  it("refuses malformed image data, oversized images and unsupported formats", () => {
    for (const image of [
      null,
      {},
      { mimeType: "text/html", data: "YQ==" },
      { mimeType: "image/png", data: "https://private" },
      { mimeType: "image/png", data: "a".repeat(3 * 1024 * 1024) },
    ])
      expect(imageMessage("openai", { image })).toBeNull();
  });
});

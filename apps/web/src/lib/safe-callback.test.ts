import { describe, expect, it } from "vitest";
import { safeCallback } from "./safe-callback";

describe("sign-in callback boundary", () => {
  it.each([
    undefined, ["/work"], "https://evil.example", "//evil.example",
    "/\\evil.example", "/safe/..//evil.example", "/safe/%2e%2e//evil.example",
    "/safe/.%2e//evil.example", "/\t/evil.example", "/\n/evil.example",
  ])("rejects an external or malformed callback: %j", value => {
    expect(safeCallback(value)).toBe("/");
  });
  it.each(["/", "/work", "/connect?state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A43891", "/work?query=hello%20world"]) (
    "preserves local navigation: %s", value => expect(safeCallback(value)).toBe(value),
  );
  it("normalizes ordinary local dot segments and removes fragments", () => {
    expect(safeCallback("/people/../work?view=files#section")).toBe("/work?view=files");
  });
});

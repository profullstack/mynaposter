import { describe, expect, test } from "bun:test";
import { Field, TextArea } from "../src/tui/field.ts";

describe("Field.paste", () => {
  test("inserts at the cursor", () => {
    const field = new Field("url", "URL", {}, "/link ");
    field.paste("https://example.com/post");
    expect(field.value).toBe("/link https://example.com/post");
    expect(field.cursor).toBe(field.value.length);
  });

  test("drops the trailing newline a copied line carries", () => {
    const field = new Field("url", "URL");
    field.paste("https://example.com/post\n");
    expect(field.value).toBe("https://example.com/post");
  });

  test("flattens inner line breaks to spaces", () => {
    const field = new Field("text", "Text");
    field.paste("one\r\ntwo\nthree\r\n");
    expect(field.value).toBe("one two three");
  });

  test("keeps the cursor in place for an empty paste", () => {
    const field = new Field("text", "Text", {}, "abc");
    field.cursor = 1;
    field.paste("\n");
    expect(field.value).toBe("abc");
    expect(field.cursor).toBe(1);
  });
});

describe("TextArea.paste", () => {
  test("keeps line breaks and normalises CRLF", () => {
    const area = new TextArea();
    area.set("start ");
    area.paste("line one\r\nline two\n");
    expect(area.value).toBe("start line one\nline two\n");
    expect(area.lines).toEqual(["start line one", "line two", ""]);
  });
});

import { describe, expect, it } from "vitest";
import { JsonlParser } from "../src/jsonl.js";

describe("JsonlParser", () => {
  it("parses fragmented JSONL records", () => {
    const parser = new JsonlParser();

    expect(parser.push('{"a":')).toEqual([]);
    expect(parser.push('1}\n{"b":2}\n')).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } }
    ]);
  });

  it("splits only on LF and allows unicode separators inside JSON strings", () => {
    const parser = new JsonlParser();
    const results = parser.push('{"text":"a b c"}\n');

    expect(results).toEqual([{ ok: true, value: { text: "a b c" } }]);
  });

  it("reports invalid JSON and continues parsing later records", () => {
    const parser = new JsonlParser();
    const results = parser.push('{"ok":true}\nnot-json\n{"ok":false}\n');

    expect(results[0]).toEqual({ ok: true, value: { ok: true } });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: { ok: false } });
  });
});

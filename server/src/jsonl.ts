export type JsonLineResult =
  | { ok: true; value: unknown }
  | { ok: false; line: string; error: Error };

export class JsonlParser {
  private buffer = "";

  push(chunk: string | Buffer): JsonLineResult[] {
    this.buffer += chunk.toString("utf8");
    const results: JsonLineResult[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;

      try {
        results.push({ ok: true, value: JSON.parse(line) });
      } catch (error) {
        results.push({
          ok: false,
          line,
          error: error instanceof Error ? error : new Error(String(error))
        });
      }
    }

    return results;
  }

  flush(): JsonLineResult[] {
    if (!this.buffer) return [];
    const line = this.buffer;
    this.buffer = "";
    try {
      return [{ ok: true, value: JSON.parse(line) }];
    } catch (error) {
      return [
        {
          ok: false,
          line,
          error: error instanceof Error ? error : new Error(String(error))
        }
      ];
    }
  }
}

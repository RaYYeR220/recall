import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

async function withServer<T>(env: Record<string, string>, run: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({ command: "bun", args: ["run", ENTRY], env: { PATH: process.env["PATH"] ?? "", ...env }, stderr: "pipe" });
  const client = new Client({ name: "stdio-test", version: "0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

describe("the stdio server, as Claude Desktop or Cursor would start it", () => {
  test("starts with no environment at all and lists nine tools", async () => {
    const names = await withServer({}, async (c) => (await c.listTools()).tools.map((t) => t.name));
    expect(names).toHaveLength(9);
    expect(names).toContain("prepare_refund");
  });

  test("a bad NETWORK stops the server instead of silently using mainnet", async () => {
    let failed = false;
    try {
      await withServer({ NETWORK: "polygon" }, (c) => c.listTools());
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

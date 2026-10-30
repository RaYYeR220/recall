import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import type { RecallContext } from "./context.js";
import { toJson } from "./format.js";
import { allTools } from "./tools/index.js";

export const SERVER_NAME = "recall-debitrail";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Recall DebitRail: direct debit for stablecoins with the refund right built in.",
  "Merchant tools act as an operator wallet and can only pre-notify, collect and cancel inside mandates payers have signed; they cannot touch the reserve or the payout address.",
  "Payer tools are read-only. They never receive or ask for a payer's key: prepare_refund returns typed data and a link, and the human signs in their own wallet.",
  'Amounts are decimals in the token (for example "12.50"). Times are ISO 8601. instance is "prod" or "demo" (demo runs 10,080 times faster).',
].join("\n");

function message(e: unknown): string {
  if (e instanceof ZodError) return `Invalid input: ${e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  return e instanceof Error ? e.message : String(e);
}

/** An MCP server exposing every tool. Transport-agnostic: connect stdio, or an in-memory pair in tests. */
export function buildServer(ctx: RecallContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of allTools(ctx)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: true },
      },
      async (args: unknown) => {
        try {
          const out = await tool.run(args);
          return { content: [{ type: "text" as const, text: `${out.summary}\n\n${toJson(out.data)}` }], ...(out.isError ? { isError: true } : {}) };
        } catch (e) {
          return { content: [{ type: "text" as const, text: message(e) }], isError: true };
        }
      },
    );
  }
  return server;
}

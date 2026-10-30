import { z, type ZodRawShape } from "zod";

/** What a tool returns: structured data for the agent, plus a one-line summary. */
export interface ToolOutput {
  summary: string;
  data: unknown;
  /** True when the tool could not do its job (missing key, bad input to the chain). A rail refusal is NOT an error: it is an answer. */
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  shape: ZodRawShape;
  /** True for tools that only read. */
  readOnly: boolean;
  run(args: unknown): Promise<ToolOutput>;
}

export function defineTool<S extends ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  shape: S;
  readOnly: boolean;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolOutput>;
}): Tool {
  const schema = z.object(def.shape);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    shape: def.shape,
    readOnly: def.readOnly,
    run: (args) => def.handler(schema.parse(args)),
  };
}

// ── shared input fields ─────────────────────────────────────────────────────

export const instanceField = z
  .enum(["prod", "demo"])
  .describe('Which rail: "prod" is the real rail, "demo" is the accelerated demo rail (1 week = 1 minute).');

export const idField = (what: string) =>
  z
    .union([z.string().regex(/^\d{1,20}$/, "a whole number"), z.number().int().nonnegative()])
    .describe(`${what} (a whole number).`);

export const bytes32Field = (what: string) =>
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "a 0x-prefixed 32-byte hex id")
    .describe(`${what} (0x-prefixed, 32 bytes).`);

export const addressField = (what: string) =>
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "a 0x-prefixed address")
    .describe(`${what} (0x-prefixed address).`);

export const toBigInt = (v: string | number): bigint => BigInt(v);

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createContext, OperatorKeyMissing, parseNetwork, parseOperatorKey } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { allTools, MERCHANT_TOOL_NAMES, PAYER_TOOL_NAMES } from "../src/tools/index.js";

const MANDATE = `0x${"ab".repeat(32)}`;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

async function connect(ctx = createContext({ network: "arc" })) {
  const server = buildServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: unknown): string => (((r as { content?: { type: string; text: string }[] }).content ?? [])[0]?.text ?? "");

describe("the tool list", () => {
  test("exposes exactly the merchant and payer tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MERCHANT_TOOL_NAMES, ...PAYER_TOOL_NAMES].sort());
    expect(tools).toHaveLength(9);
  });

  test("every tool has a description and an object input schema with described fields", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
      const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      expect(Object.keys(props).length).toBeGreaterThan(0);
      for (const [name, p] of Object.entries(props)) expect(p.description, `${t.name}.${name}`).toBeTruthy();
      expect(props["instance"]).toBeDefined();
    }
  });

  test("required fields match the spec", async () => {
    const { tools } = await (await connect()).listTools();
    const required = Object.fromEntries(tools.map((t) => [t.name, [...(t.inputSchema.required ?? [])].sort()]));
    expect(required["list_mandates"]).toEqual(["creditorId", "instance"]);
    expect(required["prenotify_collection"]).toEqual(["amount", "dueAt", "instance", "mandateId", "remittanceInfo"]);
    expect(required["collect_due"]).toEqual(["creditorId", "instance"]);
    expect(required["list_returns"]).toEqual(["creditorId", "instance"]);
    expect(required["coverage"]).toEqual(["creditorId", "instance"]);
    expect(required["list_my_debits"]).toEqual(["instance", "payer"]);
    expect(required["upcoming_debits"]).toEqual(["instance", "payer"]);
    expect(required["explain_refund_rights"]).toEqual(["collectionId", "instance"]);
    expect(required["prepare_refund"]).toEqual(["collectionId", "instance", "payer"]);
  });

  test("instance is an enum of prod and demo", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) expect((t.inputSchema.properties as Record<string, { enum?: string[] }>)["instance"]?.enum).toEqual(["prod", "demo"]);
  });

  test("only the two tools that send a transaction are not read-only", async () => {
    const { tools } = await (await connect()).listTools();
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual(["collect_due", "prenotify_collection"]);
    for (const t of tools.filter((x) => PAYER_TOOL_NAMES.includes(x.name as never))) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  test("no tool takes a private key, a seed or a signature as input", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) {
      for (const field of Object.keys(t.inputSchema.properties ?? {})) expect(field).not.toMatch(/key|secret|seed|mnemonic|signature|sig$/i);
    }
  });
});

describe("input validation", () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await (await connect()).callTool({ name, arguments: args });
    return { isError: r.isError === true, text: textOf(r) };
  };

  test("bad ids, addresses, amounts and dates are rejected before anything runs", async () => {
    for (const [name, args] of [
      ["list_mandates", { instance: "prod", creditorId: "abc" }],
      ["list_mandates", { instance: "mainnet", creditorId: "1" }],
      ["list_mandates", { instance: "prod", creditorId: "1", limit: 500 }],
      ["prenotify_collection", { instance: "prod", mandateId: "0x12", amount: "5", dueAt: "2026-12-01T09:00:00Z", remittanceInfo: "x" }],
      ["prenotify_collection", { instance: "prod", mandateId: MANDATE, amount: "five", dueAt: "2026-12-01T09:00:00Z", remittanceInfo: "x" }],
      ["prenotify_collection", { instance: "prod", mandateId: MANDATE, amount: "5.1234567", dueAt: "2026-12-01T09:00:00Z", remittanceInfo: "x" }],
      ["prenotify_collection", { instance: "prod", mandateId: MANDATE, amount: "5", dueAt: "next tuesday", remittanceInfo: "x" }],
      ["prenotify_collection", { instance: "prod", mandateId: MANDATE, amount: "5", dueAt: "2026-12-01T09:00:00Z", remittanceInfo: "x".repeat(141) }],
      ["list_my_debits", { instance: "prod", payer: "0x123" }],
      ["prepare_refund", { instance: "prod", collectionId: MANDATE, payer: "vitalik.eth" }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text).toMatch(/invalid|required|expected/i);
    }
  });

  test("missing fields are named", async () => {
    const r = await call("prepare_refund", { instance: "prod" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/collectionId/);
    expect(r.text).toMatch(/payer/);
  });
});

describe("the operator key", () => {
  test("tools that send a transaction explain what is missing when there is no key", async () => {
    const client = await connect(createContext({ network: "arc" }));
    for (const [name, args] of [
      ["prenotify_collection", { instance: "prod", mandateId: MANDATE, amount: "5", dueAt: "2026-12-01T09:00:00Z", remittanceInfo: "Gym" }],
      ["collect_due", { instance: "prod", creditorId: "1" }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("RECALL_OPERATOR_KEY");
    }
  });

  test("without a key the context refuses to hand out an operator client, but readers work", () => {
    const ctx = createContext({ network: "arc" });
    expect(() => ctx.operator("prod")).toThrow(OperatorKeyMissing);
    expect(ctx.reader("prod").rail).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(ctx.operatorAddress).toBeUndefined();
  });

  test("a malformed key is rejected without echoing it", () => {
    const bad = "0xnot-a-key-should-never-be-printed";
    let message = "";
    try {
      parseOperatorKey(bad);
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toContain("RECALL_OPERATOR_KEY");
    expect(message).not.toContain(bad);
    expect(parseOperatorKey(undefined)).toBeUndefined();
  });

  test("NETWORK defaults to mainnet and accepts only the two known values", () => {
    expect(parseNetwork(undefined)).toBe("arc");
    expect(parseNetwork("")).toBe("arc");
    expect(parseNetwork("arc")).toBe("arc");
    expect(parseNetwork("arc-testnet")).toBe("arc-testnet");
    expect(() => parseNetwork("ethereum")).toThrow();
  });

  test("nine tools are built from one context", () => {
    expect(allTools(createContext({ network: "arc" }))).toHaveLength(9);
    void PAYER;
  });
});

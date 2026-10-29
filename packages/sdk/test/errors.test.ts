import { describe, expect, test } from "bun:test";
import { BaseError, encodeErrorResult, type Abi, type AbiParameter } from "viem";
import { debitRailAbi } from "../src/abi";
import { RAIL_ERROR_MESSAGES, decodeRailError, decodeReturnCode, returnCodeLabel } from "../src/errors";

const looseAbi: Abi = debitRailAbi;
const errorItems = debitRailAbi.filter((x) => x.type === "error");

function dummy(p: AbiParameter): unknown {
  if (p.type === "string") return "x";
  if (p.type === "address") return "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  if (p.type.startsWith("uint")) return 1n;
  if (p.type === "bool") return true;
  if (p.type.startsWith("bytes")) return `0x${"00".repeat(Number(p.type.slice(5)) || 0)}`;
  throw new Error(`no dummy for ${p.type}`);
}

describe("decodeRailError", () => {
  test("the ABI has custom errors to cover", () => {
    expect(errorItems.length).toBeGreaterThanOrEqual(35);
  });

  for (const item of errorItems) {
    test(`decodes ${item.name}`, () => {
      const args = item.inputs.map(dummy);
      const data = encodeErrorResult({ abi: looseAbi, errorName: item.name, args });
      const out = decodeRailError(data);
      expect(out.name).toBe(item.name);
      expect(out.data).toBe(data);
      // Every error has a hand-written plain message, never the generic fallback.
      expect(RAIL_ERROR_MESSAGES[item.name]).toBeDefined();
      expect(out.message).toBe(RAIL_ERROR_MESSAGES[item.name]);
      expect(out.message.length).toBeGreaterThan(10);
    });
  }

  test("every message in the table belongs to a real error (no stale entries)", () => {
    const names = new Set<string>(errorItems.map((e) => e.name));
    for (const name of Object.keys(RAIL_ERROR_MESSAGES)) expect(names.has(name)).toBe(true);
  });

  test("ISO-coded errors carry their code", () => {
    const md01 = decodeRailError(encodeErrorResult({ abi: debitRailAbi, errorName: "MD01_NoValidMandate" }));
    expect(md01).toMatchObject({ name: "MD01_NoValidMandate", code: "MD01" });
    const am05 = decodeRailError(encodeErrorResult({ abi: debitRailAbi, errorName: "AM05_Duplicate" }));
    expect(am05).toMatchObject({ name: "AM05_Duplicate", code: "AM05" });
  });

  test("errors without an ISO code give a plain message and null code", () => {
    const e = decodeRailError(encodeErrorResult({ abi: debitRailAbi, errorName: "RefundWindowClosed" }));
    expect(e.code).toBeNull();
    expect(e.message).toBe("The refund window has closed, so this can no longer be refunded.");
  });

  test("finds revert data inside a nested viem-style error chain", () => {
    const data = encodeErrorResult({ abi: debitRailAbi, errorName: "TooEarly" });
    const inner = Object.assign(new Error("reverted"), { raw: data });
    const middle = Object.assign(new Error("call failed"), { cause: inner });
    const outer = new BaseError("Execution reverted", { cause: middle });
    expect(decodeRailError(outer).name).toBe("TooEarly");
    // RPC-style: { error: { data } }
    expect(decodeRailError({ error: { data } }).name).toBe("TooEarly");
  });

  test("decodes a plain revert string", () => {
    // Error("nope")
    const data =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000004" +
      "6e6f706500000000000000000000000000000000000000000000000000000000";
    expect(decodeRailError(data)).toMatchObject({ name: "Error", message: "Reverted: nope" });
  });

  test("unknown selectors and non-errors fall back to the original message", () => {
    expect(decodeRailError("0xdeadbeef")).toMatchObject({ name: "UnknownError", code: null });
    const out = decodeRailError(new Error("network down\nstack stuff"));
    expect(out).toMatchObject({ name: "UnknownError", message: "network down" });
    expect(decodeRailError(undefined).name).toBe("UnknownError");
  });
});

describe("returnCodeLabel", () => {
  const expected: Record<string, string> = {
    AM04: "Insufficient funds",
    MS02: "Refused by the payer",
    MS03: "Reason not specified",
    MD01: "No valid mandate",
    MD06: "Refund requested by the payer",
    AM05: "Duplicate collection",
  };
  for (const [code, label] of Object.entries(expected)) {
    test(`${code}`, () => {
      expect(returnCodeLabel(code)).toBe(label);
      // the bytes4 stored in a Collection works too
      const hex = `0x${Buffer.from(code).toString("hex")}`;
      expect(decodeReturnCode(hex)).toBe(code);
      expect(returnCodeLabel(hex)).toBe(label);
    });
  }

  test("unknown and empty codes", () => {
    expect(returnCodeLabel("ZZ99")).toBe("Unknown reason (ZZ99)");
    expect(returnCodeLabel("0x00000000")).toBe("");
    expect(returnCodeLabel("am04")).toBe("Insufficient funds");
  });
});

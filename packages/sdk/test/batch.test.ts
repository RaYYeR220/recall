import { describe, expect, test } from "bun:test";
import { parseAmountUnits, parseBatchCsv, parseCsv, BATCH_MAX_ROWS } from "../src/batch";

const M = `0x${"ab".repeat(32)}` as const;

describe("parseCsv", () => {
  test("plain rows, CRLF and a trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
  test("quotes, doubled quotes, commas and newlines inside quotes", () => {
    expect(parseCsv('x,y\n"a,b","say ""hi"""\n"two\nlines",z')).toEqual([["x", "y"], ["a,b", 'say "hi"'], ["two\nlines", "z"]]);
  });
  test("strips a byte-order mark", () => {
    expect(parseCsv("\uFEFFa,b")).toEqual([["a", "b"]]);
  });
});

describe("parseAmountUnits", () => {
  test("decimal strings become 6-decimal units", () => {
    expect(parseAmountUnits("12.5")).toBe(12_500000n);
    expect(parseAmountUnits("0.000001")).toBe(1n);
    expect(parseAmountUnits(" 3 ")).toBe(3_000000n);
  });
  test("rejects zero, negatives, 7 decimals and junk", () => {
    for (const bad of ["0", "0.0", "-1", "1.1234567", "1e3", "", "abc", "1,5"]) expect(() => parseAmountUnits(bad)).toThrow();
  });
});

describe("parseBatchCsv", () => {
  const head = "mandateId,amount,dueAt,remittance";

  test("reads good rows in any column order and ignores extra columns", () => {
    const csv = `note,remittance,dueAt,amount,mandateId\nx,Gym May,2026-12-01T09:00:00Z,12.50,${M}\n`;
    const { rows, errors } = parseBatchCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ line: 2, mandateId: M, amount: 12_500000n, dueAt: BigInt(Date.UTC(2026, 11, 1, 9) / 1000), remittance: "Gym May" }]);
  });

  test("a quoted remittance may contain commas", () => {
    const { rows } = parseBatchCsv(`${head}\n${M},1,2026-12-01T09:00:00Z,"Rent, Dec"`);
    expect(rows[0]?.remittance).toBe("Rent, Dec");
  });

  test("bad rows are reported by line and the good ones still come through", () => {
    const csv = [head, `${M},1,2026-12-01T09:00:00Z,ok`, `0x12,1,2026-12-01T09:00:00Z,short id`, `${M},0,2026-12-01T09:00:00Z,zero`, `${M},1,tomorrow,bad date`, `${M},1,2026-12-01T09:00:00Z,${"x".repeat(141)}`].join("\n");
    const { rows, errors } = parseBatchCsv(csv);
    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(errors[0]?.message).toMatch(/mandateId/);
    expect(errors[2]?.message).toMatch(/ISO/);
    expect(errors[3]?.message).toMatch(/140/);
  });

  test("a missing column is one clear error", () => {
    const { rows, errors } = parseBatchCsv("mandateId,amount\nx,1");
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/dueAt, remittance/);
  });

  test("empty input, blank lines, and the row cap", () => {
    expect(parseBatchCsv("").errors[0]?.message).toMatch(/empty/);
    expect(parseBatchCsv(`${head}\n\n\n`).rows).toEqual([]);
    const many = [head, ...Array.from({ length: BATCH_MAX_ROWS + 5 }, () => `${M},1,2026-12-01T09:00:00Z,r`)].join("\n");
    const r = parseBatchCsv(many);
    expect(r.rows).toHaveLength(BATCH_MAX_ROWS);
    expect(r.errors[r.errors.length - 1]?.message).toMatch(/first 500/);
  });
});

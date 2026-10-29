import { isHex, size, type Hex } from "viem";
import { TOKEN_DECIMALS } from "./networks.js";

export interface BatchRow {
  /** 1-based line number in the file (the header is line 1). */
  line: number;
  mandateId: Hex;
  /** Smallest units (6 decimals). */
  amount: bigint;
  /** Unix seconds. */
  dueAt: bigint;
  remittance: string;
}

export interface BatchError {
  line: number;
  message: string;
}

export const BATCH_MAX_ROWS = 500;
export const BATCH_MAX_REMITTANCE = 140;
const REQUIRED = ["mandateid", "amount", "dueat", "remittance"] as const;

/** RFC 4180-style CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "12.50" -> 12_500000n. At most 6 decimals, greater than zero. */
export function parseAmountUnits(value: string): bigint {
  const v = value.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v);
  if (!m) throw new Error(`"${value}" is not an amount with at most ${TOKEN_DECIMALS} decimals.`);
  const units = BigInt(m[1]) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((m[2] ?? "").padEnd(TOKEN_DECIMALS, "0") || "0");
  if (units <= 0n) throw new Error("The amount must be greater than zero.");
  return units;
}

/**
 * Parses a batch pre-notification file with the columns `mandateId, amount, dueAt, remittance`
 * (any order, extra columns ignored). `dueAt` is an ISO 8601 date-time. Bad rows are reported by line and skipped.
 */
export function parseBatchCsv(text: string): { rows: BatchRow[]; errors: BatchError[] } {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const errors: BatchError[] = [];
  const rows: BatchRow[] = [];
  const header = table[0]?.map((h) => h.trim().toLowerCase());
  if (!header) return { rows, errors: [{ line: 1, message: "The file is empty." }] };
  const col = Object.fromEntries(REQUIRED.map((name) => [name, header.indexOf(name)])) as Record<(typeof REQUIRED)[number], number>;
  const missing = REQUIRED.filter((n) => col[n] < 0);
  if (missing.length > 0) {
    return { rows, errors: [{ line: 1, message: `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Expected mandateId, amount, dueAt, remittance.` }] };
  }
  const data = table.slice(1);
  if (data.length > BATCH_MAX_ROWS) {
    errors.push({ line: BATCH_MAX_ROWS + 2, message: `Only the first ${BATCH_MAX_ROWS} rows are read.` });
  }
  data.slice(0, BATCH_MAX_ROWS).forEach((cells, i) => {
    const line = i + 2;
    const get = (n: (typeof REQUIRED)[number]) => (cells[col[n]] ?? "").trim();
    try {
      const mandateId = get("mandateid");
      if (!isHex(mandateId, { strict: true }) || size(mandateId) !== 32) throw new Error("mandateId must be 32 bytes of hex (0x…).");
      const amount = parseAmountUnits(get("amount"));
      const dueRaw = get("dueat");
      const ms = Date.parse(dueRaw);
      if (!/^\d{4}-\d{2}-\d{2}/.test(dueRaw) || Number.isNaN(ms)) throw new Error("dueAt must be an ISO date-time such as 2026-12-01T09:00:00Z.");
      const remittance = get("remittance");
      if (remittance.length > BATCH_MAX_REMITTANCE) throw new Error(`remittance is longer than ${BATCH_MAX_REMITTANCE} characters.`);
      rows.push({ line, mandateId: mandateId, amount, dueAt: BigInt(Math.floor(ms / 1000)), remittance });
    } catch (e) {
      errors.push({ line, message: e instanceof Error ? e.message : "Could not read this row." });
    }
  });
  return { rows, errors };
}

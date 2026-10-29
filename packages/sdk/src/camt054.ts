import { formatUnits, hexToBytes, type Address, type Hex } from "viem";
import { decodeReturnCode, returnCodeLabel } from "./errors.js";
import { TOKEN_DECIMALS, networkInfo, type RailInstance, type RailNetwork } from "./networks.js";

/**
 * One line of a statement: a collection, a refund of it, or a return (a collection that was
 * refused or failed and never moved money).
 */
export interface StatementEntry {
  kind: "collection" | "refund" | "return";
  /** Which token moved. EURC is reported as currency EUR, USDC as USD. */
  token: "EURC" | "USDC";
  /** Smallest units (6 decimals). */
  amount: bigint;
  collectionId: Hex;
  mandateId: Hex;
  /** The end-to-end ID (bytes32). Printable right-padded text is shown as text. */
  e2eId: Hex;
  creditorId?: bigint;
  creditorName?: string;
  /** Payer wallet. */
  debtor: Address;
  /** Unix seconds when the entry was booked (block time). */
  bookedAt: number | bigint;
  /** Unix seconds of the value date (usually the due date). Defaults to `bookedAt`. */
  valueAt?: number | bigint;
  /** The collection's remittance text. */
  remittanceInfo?: string;
  /** ISO 20022 reason code, "AM04" or the raw bytes4. Required for returns, optional for refunds (defaults to MD06). */
  returnCode?: string;
  txHash: Hex;
  blockNumber?: bigint | number;
  /** CORE or B2B. Selects the bank transaction sub-family. Default CORE. */
  scheme?: "CORE" | "B2B";
}

export interface StatementMeta {
  network: RailNetwork;
  instance: RailInstance;
  /** Rail contract the entries came from. */
  rail: Address;
  /** The account the statement is for: the creditor's payout address, or the payer's wallet. */
  account: Address;
  accountName?: string;
  /** Whose books these are. Flips credit and debit. Default "creditor". */
  perspective?: "creditor" | "debtor";
  /** Max35Text. Generated from `createdAt` when omitted. */
  messageId?: string;
  /** Unix seconds or Date. Defaults to now. */
  createdAt?: number | bigint | Date;
}

const CCY = { EURC: "EUR", USDC: "USD" } as const;

// ── XML helpers ──────────────────────────────────────────────────────────────

/** Escapes text for XML and drops characters XML 1.0 cannot carry. */
export function escapeXml(s: string): string {
  return (
    s
      // oxlint-disable-next-line no-control-regex -- dropping illegal XML chars is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

const el = (name: string, body: string, attrs = "") => `<${name}${attrs}>${body}</${name}>`;
const text = (name: string, value: string, attrs = "") => el(name, escapeXml(value), attrs);

function toDate(t: number | bigint | Date): Date {
  return t instanceof Date ? t : new Date(Number(t) * 1000);
}

const isoDateTime = (t: number | bigint | Date) => toDate(t).toISOString().replace(/\.\d{3}Z$/, "Z");
const isoDate = (t: number | bigint | Date) => toDate(t).toISOString().slice(0, 10);

/** 6-decimal token amount as a plain decimal string with at least 2 fraction digits and no float rounding. */
export function formatAmount(v: bigint): string {
  const [whole, frac = ""] = formatUnits(v, TOKEN_DECIMALS).split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/** An e2eId shown as text when its bytes are printable ASCII followed only by zero padding. */
export function e2eIdText(e2eId: Hex): string {
  const bytes = hexToBytes(e2eId);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  if (end === 0) return e2eId;
  for (let i = 0; i < end; i++) {
    const b = bytes[i] ?? 0;
    if (b < 0x20 || b > 0x7e) return e2eId;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}

/** Max35Text form of an identifier: the text itself if it fits, otherwise the first 35 characters. */
function ref35(id: string): string {
  return id.length <= 35 ? id : id.slice(0, 35);
}

// ── Entry classification ─────────────────────────────────────────────────────

type Perspective = "creditor" | "debtor";

function entryParts(e: StatementEntry, perspective: Perspective) {
  const creditorSide = perspective === "creditor";
  // A collection credits the creditor and debits the payer. A refund is the reverse.
  const collectionDir: "CRDT" | "DBIT" = creditorSide ? "CRDT" : "DBIT";
  const flip = (d: "CRDT" | "DBIT"): "CRDT" | "DBIT" => (d === "CRDT" ? "DBIT" : "CRDT");

  const b2b = e.scheme === "B2B";
  const family = creditorSide ? "IDDT" : "RDDT"; // issued / received direct debits
  switch (e.kind) {
    case "collection":
      return {
        dir: collectionDir,
        reversal: false,
        status: "BOOK",
        family,
        subFamily: b2b ? "BBDD" : "ESDD",
        reason: undefined as string | undefined,
      };
    case "refund":
      return {
        dir: flip(collectionDir),
        reversal: true,
        status: "BOOK",
        family,
        subFamily: "PRDD",
        reason: e.returnCode ? decodeReturnCode(e.returnCode) : "MD06",
      };
    case "return": {
      const reason = e.returnCode ? decodeReturnCode(e.returnCode) : "";
      if (!reason) throw new Error(`Statement entry ${e.collectionId}: a return needs a returnCode.`);
      // No money moved, so this is informational: same direction as the attempted collection, flagged as a reversal.
      return { dir: collectionDir, reversal: true, status: "INFO", family, subFamily: "UPDD", reason };
    }
  }
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function ntry(e: StatementEntry, meta: StatementMeta, perspective: Perspective, index: number): string {
  const p = entryParts(e, perspective);
  const ccy = CCY[e.token];
  const booked = e.bookedAt;
  const value = e.valueAt ?? e.bookedAt;
  const e2eText = e2eIdText(e.e2eId);

  const refs = el(
    "Refs",
    text("EndToEndId", ref35(e2eText)) + text("TxId", ref35(e.collectionId)) + text("MndtId", ref35(e.mandateId)),
  );

  const parties: string[] = [];
  const debtorAcct = el("DbtrAcct", el("Id", el("Othr", text("Id", e.debtor))));
  const creditorName = e.creditorName ?? (perspective === "creditor" ? meta.accountName : undefined);
  const cdtr = creditorName ? el("Cdtr", el("Pty", text("Nm", creditorName.slice(0, 140)))) : "";
  const cdtrAcct =
    perspective === "creditor" ? el("CdtrAcct", el("Id", el("Othr", text("Id", meta.account)))) : "";
  parties.push(debtorAcct, cdtr, cdtrAcct);

  const bkTx = el(
    "BkTxCd",
    el("Domn", text("Cd", "PMNT") + el("Fmly", text("Cd", p.family) + text("SubFmlyCd", p.subFamily))),
  );

  const rmt = e.remittanceInfo
    ? el("RmtInf", chunk(e.remittanceInfo, 140).map((c) => text("Ustrd", c)).join(""))
    : "";
  const rtr = p.reason
    ? el(
        "RtrInf",
        el("Rsn", text("Cd", p.reason)) + text("AddtlInf", returnCodeLabel(p.reason).slice(0, 105)),
      )
    : "";

  const addtlParts = [
    `tx ${e.txHash}`,
    e.blockNumber !== undefined ? `block ${e.blockNumber}` : "",
    `chain ${networkInfo(meta.network).chainId}`,
    `rail ${meta.rail} (${meta.instance})`,
    `token ${e.token}`,
    `collectionId ${e.collectionId}`,
    `mandateId ${e.mandateId}`,
    e.e2eId !== e2eText ? `e2eId ${e.e2eId}` : "",
  ].filter(Boolean);

  return el(
    "Ntry",
    text("NtryRef", ref35(`${index + 1}`)) +
      text("Amt", formatAmount(e.amount), ` Ccy="${ccy}"`) +
      text("CdtDbtInd", p.dir) +
      (p.reversal ? text("RvslInd", "true") : "") +
      el("Sts", text("Cd", p.status)) +
      el("BookgDt", text("DtTm", isoDateTime(booked))) +
      el("ValDt", text("Dt", isoDate(value))) +
      bkTx +
      el("NtryDtls", el("TxDtls", refs + el("RltdPties", parties.join("")) + rmt + rtr)) +
      text("AddtlNtryInf", addtlParts.join("; ").slice(0, 500)),
  );
}

/**
 * Builds an ISO 20022 camt.054.001.08 (bank-to-customer debit/credit notification) from rail
 * activity. Entries are grouped into one `Ntfctn` per token (each has its own currency).
 *
 * Notes on fidelity:
 * - EURC is reported as currency EUR and USDC as USD, because ISO 20022 has no stablecoin codes.
 * - Reference fields are Max35Text in the schema. The EndToEndId, TxId and MndtId shown there are
 *   the full value when it fits and a 35-character prefix when it does not; the full ids are always
 *   in AddtlNtryInf together with the transaction hash.
 * - Amounts keep all 6 decimals. ISO allows 5 fraction digits, so a sub-1e-5 remainder is kept
 *   rather than silently rounded.
 */
export function toCamt054(entries: readonly StatementEntry[], meta: StatementMeta): string {
  const perspective: Perspective = meta.perspective ?? "creditor";
  const created = meta.createdAt ?? new Date();
  const createdIso = isoDateTime(created);
  const msgId = ref35(meta.messageId ?? `RECALL-${createdIso.replace(/\D/g, "")}`);

  const byToken = new Map<StatementEntry["token"], StatementEntry[]>();
  for (const e of entries) {
    const list = byToken.get(e.token) ?? [];
    list.push(e);
    byToken.set(e.token, list);
  }
  // Stable order: EURC then USDC.
  const tokens = (["EURC", "USDC"] as const).filter((t) => byToken.has(t));

  const info = networkInfo(meta.network);
  const acctName = meta.accountName ? `${meta.accountName}` : `Recall DebitRail ${meta.instance}`;

  const ntfctns = tokens
    .map((token, i) => {
      const list = byToken.get(token) ?? [];
      return el(
        "Ntfctn",
        text("Id", ref35(`${msgId}-${i + 1}`)) +
          text("CreDtTm", createdIso) +
          el(
            "Acct",
            el("Id", el("Othr", text("Id", meta.account))) +
              text("Ccy", CCY[token]) +
              text("Nm", `${acctName} (${info.chain.name})`.slice(0, 70)),
          ) +
          list.map((e, idx) => ntry(e, meta, perspective, idx)).join(""),
      );
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    el(
      "Document",
      el(
        "BkToCstmrDbtCdtNtfctn",
        el("GrpHdr", text("MsgId", msgId) + text("CreDtTm", createdIso)) + ntfctns,
      ),
      ` xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08"`,
    )
  );
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  "booked_at",
  "value_date",
  "kind",
  "direction",
  "amount",
  "currency",
  "token",
  "end_to_end_id",
  "mandate_id",
  "collection_id",
  "return_code",
  "return_reason",
  "remittance_info",
  "debtor",
  "creditor",
  "tx_hash",
  "block",
] as const;

/** Quotes a cell. Cells that start with = + - @ get a leading apostrophe so spreadsheets never run them as formulas. */
export function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One row per entry, with a header row. */
export function toCsv(entries: readonly StatementEntry[], opts: { perspective?: Perspective } = {}): string {
  const perspective = opts.perspective ?? "creditor";
  const rows = entries.map((e) => {
    const p = entryParts(e, perspective);
    const reason = p.reason ?? "";
    return [
      isoDateTime(e.bookedAt),
      isoDate(e.valueAt ?? e.bookedAt),
      e.kind,
      p.dir,
      formatAmount(e.amount),
      CCY[e.token],
      e.token,
      e2eIdText(e.e2eId),
      e.mandateId,
      e.collectionId,
      reason,
      reason ? returnCodeLabel(reason) : "",
      e.remittanceInfo ?? "",
      e.debtor,
      e.creditorName ?? "",
      e.txHash,
      e.blockNumber !== undefined ? String(e.blockNumber) : "",
    ].map(csvCell);
  });
  return [CSV_COLUMNS.join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
}

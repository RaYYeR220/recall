import { describe, expect, test } from "bun:test";
import { csvCell, e2eIdText, escapeXml, toCamt054, toCsv, type StatementEntry, type StatementMeta } from "../src/camt054";
import { refToBytes32 } from "../src/terms";

const TX = `0x${"ab".repeat(32)}` as const;
const MANDATE = `0x${"11".repeat(32)}` as const;
const COLLECTION = `0x${"22".repeat(32)}` as const;
const DEBTOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const PAYOUT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const RAIL = "0x8a91eB44cF5d213C2230A42D1DF84585224075B0" as const;

const meta: StatementMeta = {
  network: "arc",
  instance: "prod",
  rail: RAIL,
  account: PAYOUT,
  accountName: "Acme Gym",
  messageId: "STMT-0001",
  createdAt: new Date("2026-10-29T10:00:00Z"),
};

function entry(overrides: Partial<StatementEntry> = {}): StatementEntry {
  return {
    kind: "collection",
    token: "EURC",
    amount: 25_500_000n,
    collectionId: COLLECTION,
    mandateId: MANDATE,
    e2eId: refToBytes32("INV-2026-001"),
    creditorName: "Acme Gym",
    debtor: DEBTOR,
    bookedAt: 1_793_268_000, // 2026-10-29T10:00:00Z
    valueAt: 1_793_232_000, // 2026-10-29
    remittanceInfo: "Membership November",
    txHash: TX,
    blockNumber: 28_300_000n,
    ...overrides,
  };
}

/** Minimal well-formedness check: tags nest and close, one root. */
function assertBalanced(xml: string) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(body))) {
    const [, close, name, , selfClose] = m;
    expect(body.slice(last, m.index)).not.toMatch(/[<>]/);
    last = re.lastIndex;
    if (selfClose) continue;
    if (close) expect(stack.pop()).toBe(name);
    else stack.push(name);
  }
  expect(stack).toEqual([]);
}

describe("toCamt054", () => {
  const xml = toCamt054([entry()], meta);

  test("has the camt.054.001.08 envelope and group header", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.08">');
    expect(xml).toContain("<BkToCstmrDbtCdtNtfctn>");
    expect(xml).toContain("<GrpHdr><MsgId>STMT-0001</MsgId><CreDtTm>2026-10-29T10:00:00Z</CreDtTm></GrpHdr>");
    assertBalanced(xml);
  });

  test("a collection becomes a booked credit entry with references", () => {
    expect(xml).toContain("<Ntfctn>");
    expect(xml).toContain('<Amt Ccy="EUR">25.50</Amt>');
    expect(xml).toContain("<CdtDbtInd>CRDT</CdtDbtInd>");
    expect(xml).not.toContain("<RvslInd>");
    expect(xml).toContain("<Sts><Cd>BOOK</Cd></Sts>");
    expect(xml).toContain("<BookgDt><DtTm>2026-10-29T10:00:00Z</DtTm></BookgDt>");
    expect(xml).toContain("<ValDt><Dt>2026-10-29</Dt></ValDt>");
    expect(xml).toContain("<NtryDtls><TxDtls><Refs>");
    expect(xml).toContain("<EndToEndId>INV-2026-001</EndToEndId>");
    expect(xml).toContain(`<MndtId>${MANDATE.slice(0, 35)}</MndtId>`);
    expect(xml).toContain("<RmtInf><Ustrd>Membership November</Ustrd></RmtInf>");
    expect(xml).toContain("<SubFmlyCd>ESDD</SubFmlyCd>");
  });

  test("AddtlNtryInf carries the transaction hash and the full identifiers", () => {
    expect(xml).toContain("<AddtlNtryInf>");
    expect(xml).toContain(`tx ${TX}`);
    expect(xml).toContain("block 28300000");
    expect(xml).toContain("chain 5042");
    expect(xml).toContain(`collectionId ${COLLECTION}`);
    expect(xml).toContain(`mandateId ${MANDATE}`);
  });

  test("schema element order inside Ntry is respected", () => {
    const order = ["<NtryRef>", "<Amt ", "<CdtDbtInd>", "<Sts>", "<BookgDt>", "<ValDt>", "<BkTxCd>", "<NtryDtls>", "<AddtlNtryInf>"];
    const idx = order.map((t) => xml.indexOf(t));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const refs = ["<EndToEndId>", "<TxId>", "<MndtId>"].map((t) => xml.indexOf(t));
    expect([...refs].sort((a, b) => a - b)).toEqual(refs);
  });

  test("a refund is a reversal debit with return reason MD06", () => {
    const x = toCamt054([entry({ kind: "refund" })], meta);
    expect(x).toContain("<CdtDbtInd>DBIT</CdtDbtInd>");
    expect(x).toContain("<RvslInd>true</RvslInd>");
    expect(x).toContain("<SubFmlyCd>PRDD</SubFmlyCd>");
    expect(x).toContain("<RtrInf><Rsn><Cd>MD06</Cd></Rsn>");
    assertBalanced(x);
  });

  test("a return carries its ISO reason code and is informational (no money moved)", () => {
    const x = toCamt054([entry({ kind: "return", returnCode: "0x414d3034" })], meta);
    expect(x).toContain("<RtrInf><Rsn><Cd>AM04</Cd></Rsn><AddtlInf>Insufficient funds</AddtlInf></RtrInf>");
    expect(x).toContain("<Sts><Cd>INFO</Cd></Sts>");
    expect(x).toContain("<RvslInd>true</RvslInd>");
    expect(x).toContain("<SubFmlyCd>UPDD</SubFmlyCd>");
    expect(() => toCamt054([entry({ kind: "return" })], meta)).toThrow(/returnCode/);
  });

  test("the payer's books flip credit and debit", () => {
    const x = toCamt054([entry(), entry({ kind: "refund", collectionId: `0x${"33".repeat(32)}` })], {
      ...meta,
      perspective: "debtor",
    });
    const dirs = [...x.matchAll(/<CdtDbtInd>(\w+)<\/CdtDbtInd>/g)].map((m) => m[1]);
    expect(dirs).toEqual(["DBIT", "CRDT"]);
    expect(x).toContain("<Fmly><Cd>RDDT</Cd>");
  });

  test("one notification per token, each in its own currency", () => {
    const x = toCamt054([entry(), entry({ token: "USDC", collectionId: `0x${"44".repeat(32)}` })], meta);
    expect(x.match(/<Ntfctn>/g)?.length).toBe(2);
    expect(x).toContain("<Ccy>EUR</Ccy>");
    expect(x).toContain("<Ccy>USD</Ccy>");
    expect(x).toContain('<Amt Ccy="USD">25.50</Amt>');
  });

  test("escapes XML in every free-text field and strips illegal characters", () => {
    const evil = `</Ustrd><script>alert("x")</script> & 'q' \u0000\u0008`;
    const x = toCamt054(
      [entry({ remittanceInfo: evil, creditorName: `A&B <Gym>`, e2eId: refToBytes32("a<b>&c") })],
      { ...meta, accountName: `Acme "Gym" & Co`, messageId: "M&<1>" },
    );
    expect(x).not.toContain("<script>");
    expect(x).not.toContain("</Ustrd><script");
    expect(x).toContain("&lt;/Ustrd&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;q&apos;");
    expect(x).toContain("<Nm>A&amp;B &lt;Gym&gt;</Nm>");
    expect(x).toContain("<EndToEndId>a&lt;b&gt;&amp;c</EndToEndId>");
    expect(x).toContain("<MsgId>M&amp;&lt;1&gt;</MsgId>");
    expect(x).not.toMatch(/[\u0000-\u0008]/);
    assertBalanced(x);
  });

  test("long remittance text is split into 140-character Ustrd lines", () => {
    const x = toCamt054([entry({ remittanceInfo: "z".repeat(300) })], meta);
    expect([...x.matchAll(/<Ustrd>(z+)<\/Ustrd>/g)].map((m) => m[1].length)).toEqual([140, 140, 20]);
  });

  test("keeps the full 6-decimal precision", () => {
    expect(toCamt054([entry({ amount: 1n })], meta)).toContain('<Amt Ccy="EUR">0.000001</Amt>');
    expect(toCamt054([entry({ amount: 1_000_000_000n })], meta)).toContain('<Amt Ccy="EUR">1000.00</Amt>');
  });

  test("an empty statement is still a valid document", () => {
    const x = toCamt054([], meta);
    expect(x).toContain("<GrpHdr>");
    expect(x).not.toContain("<Ntfctn>");
    assertBalanced(x);
  });
});

describe("helpers", () => {
  test("escapeXml", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
  });

  test("e2eIdText shows printable ids as text and anything else as hex", () => {
    expect(e2eIdText(refToBytes32("INV-1"))).toBe("INV-1");
    const raw = `0x${"ab".repeat(32)}` as const;
    expect(e2eIdText(raw)).toBe(raw);
  });
});

describe("toCsv", () => {
  test("has a header and one row per entry", () => {
    const csv = toCsv([entry(), entry({ kind: "return", returnCode: "MS02", collectionId: `0x${"55".repeat(32)}` })]);
    const lines = csv.trim().split("\r\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toStartWith("booked_at,value_date,kind,direction,amount,currency,token,end_to_end_id");
    expect(lines[1]).toContain("2026-10-29T10:00:00Z,2026-10-29,collection,CRDT,25.50,EUR,EURC,INV-2026-001");
    expect(lines[2]).toContain("return,CRDT");
    expect(lines[2]).toContain("MS02,Refused by the payer");
    expect(lines[1]).toContain(TX);
  });

  test("quotes commas, quotes and newlines, and defuses spreadsheet formulas", () => {
    expect(csvCell('a,b "c"\nd')).toBe('"a,b ""c""\nd"');
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell("plain")).toBe("plain");
    const csv = toCsv([entry({ remittanceInfo: "=cmd|' /C calc'!A0" })]);
    expect(csv).toContain("'=cmd");
  });
});

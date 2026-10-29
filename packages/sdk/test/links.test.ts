import { beforeAll, describe, expect, test } from "bun:test";
import { createRailClient } from "../src/client";
import { CheckoutLinkError, decodeCheckoutLink, encodeCheckoutLink, verifyOfferSignature } from "../src/links";
import { mandateText, refToBytes32, termsHash } from "../src/terms";
import { Scheme, ZERO_ADDRESS, type MandateOffer } from "../src/types";
import { SAMPLE_SIG, sampleOffer } from "./fixtures";
import { anvilAvailable, getEnv, type TestEnv } from "./helpers";

const BASE = "https://recall.example/pay";

function payload() {
  const terms = mandateText({
    creditorName: "Acme Gym",
    instance: "prod",
    token: "EURC",
    scheme: "CORE",
    oneOff: false,
    maxPerCollection: 100_000_000n,
    maxPerPeriod: 200_000_000n,
    periodLength: 30 * 86_400,
    prenoticeLength: 14 * 86_400,
    maxUses: 0,
    validUntil: 1_900_000_000n,
  });
  return {
    network: "arc" as const,
    instance: "prod" as const,
    offer: sampleOffer({ termsHash: termsHash(terms) }),
    offerSig: SAMPLE_SIG,
    creditorName: "Acme Gym",
    terms,
  };
}

/** Re-encodes a link after editing the decoded wire JSON, to simulate an attacker editing the URL. */
function editLink(url: string, edit: (wire: Record<string, unknown>) => void): string {
  const u = new URL(url);
  const b64 = new URLSearchParams(u.hash.slice(1)).get("r")!;
  const wire = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as Record<string, unknown>;
  edit(wire);
  u.hash = `r=${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
  return u.toString();
}

describe("checkout links", () => {
  test("round trip preserves every field, including bigints and unicode", () => {
    const p = payload();
    p.creditorName = "Café Zoë 東京";
    const url = encodeCheckoutLink(BASE, p);
    const out = decodeCheckoutLink(url);
    expect(out).toEqual(p);
    expect(typeof out.offer.creditorId).toBe("bigint");
  });

  test("keeps the data out of the query string and is URL-safe", () => {
    const url = encodeCheckoutLink(BASE, payload());
    const u = new URL(url);
    expect(u.search).toBe("");
    expect(u.hash).toMatch(/^#r=[A-Za-z0-9_-]+$/);
    expect(u.origin + u.pathname).toBe(BASE);
  });

  test("also decodes the data from a query parameter", () => {
    const url = encodeCheckoutLink(BASE, payload());
    const data = new URL(url).hash.slice(3);
    expect(decodeCheckoutLink(`${BASE}?r=${data}`)).toEqual(payload());
  });

  test("round trip works for a demo-rail link and a B2B, specific-debtor offer", () => {
    const terms = "demo terms";
    const p = {
      network: "arc-testnet" as const,
      instance: "demo" as const,
      offer: sampleOffer({
        scheme: Scheme.B2B,
        oneOff: true,
        timeScale: 10080,
        debtor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        termsHash: termsHash(terms),
      }),
      offerSig: SAMPLE_SIG,
      creditorName: "Demo Shop",
      terms,
    };
    expect(decodeCheckoutLink(encodeCheckoutLink(BASE, p))).toEqual(p);
  });

  describe("tamper detection", () => {
    const url = encodeCheckoutLink(BASE, payload());

    test("edited terms text no longer matches the signed hash", () => {
      const bad = editLink(url, (w) => {
        w["t"] = `${String(w["t"])} You also authorise unlimited collections.`;
      });
      expect(() => decodeCheckoutLink(bad)).toThrow(/mandate text/);
    });

    test("edited terms hash no longer matches the text", () => {
      const bad = editLink(url, (w) => {
        (w["o"] as Record<string, unknown>)["termsHash"] = `0x${"11".repeat(32)}`;
      });
      expect(() => decodeCheckoutLink(bad)).toThrow(/mandate text/);
    });

    test("an offer for the wrong time scale is rejected", () => {
      const bad = editLink(url, (w) => {
        (w["o"] as Record<string, unknown>)["timeScale"] = 10080;
      });
      expect(() => decodeCheckoutLink(bad)).toThrow(/time scale/);
    });

    test("swapping the instance without the offer is rejected", () => {
      const bad = editLink(url, (w) => {
        w["i"] = "demo";
      });
      expect(() => decodeCheckoutLink(bad)).toThrow(/time scale/);
    });

    const shapeCases: [string, (w: Record<string, unknown>) => void][] = [
      ["unknown version", (w) => (w["v"] = 2)],
      ["unknown network", (w) => (w["n"] = "mainnet")],
      ["unknown instance", (w) => (w["i"] = "staging")],
      ["non-numeric amount", (w) => ((w["o"] as Record<string, unknown>)["maxPerCollection"] = "1e9")],
      ["negative amount", (w) => ((w["o"] as Record<string, unknown>)["maxPerPeriod"] = "-5")],
      ["amount overflowing uint128", (w) => ((w["o"] as Record<string, unknown>)["maxPerCollection"] = (1n << 128n).toString())],
      ["bad token address", (w) => ((w["o"] as Record<string, unknown>)["token"] = "0x1234")],
      ["bad scheme", (w) => ((w["o"] as Record<string, unknown>)["scheme"] = 2)],
      ["fractional period", (w) => ((w["o"] as Record<string, unknown>)["periodLength"] = 1.5)],
      ["short offerRef", (w) => ((w["o"] as Record<string, unknown>)["offerRef"] = "0x1234")],
      ["missing offer", (w) => delete w["o"]],
      ["non-hex signature", (w) => (w["s"] = "not-a-signature")],
      ["empty creditor name", (w) => (w["c"] = "")],
      ["non-string terms", (w) => (w["t"] = 42)],
    ];
    for (const [name, edit] of shapeCases) {
      test(`rejects ${name}`, () => {
        expect(() => decodeCheckoutLink(editLink(url, edit))).toThrow(CheckoutLinkError);
      });
    }

    test("rejects garbage, truncation and missing data", () => {
      expect(() => decodeCheckoutLink("not a url")).toThrow(CheckoutLinkError);
      expect(() => decodeCheckoutLink(BASE)).toThrow(/no mandate data/);
      expect(() => decodeCheckoutLink(`${BASE}#r=%%%`)).toThrow(CheckoutLinkError);
      expect(() => decodeCheckoutLink(`${BASE}#r=${"A".repeat(40_000)}`)).toThrow(/too large/);
      expect(() => decodeCheckoutLink(url.slice(0, url.length - 25))).toThrow(CheckoutLinkError);
      const notJson = Buffer.from("hello").toString("base64url");
      expect(() => decodeCheckoutLink(`${BASE}#r=${notJson}`)).toThrow(/valid JSON/);
    });
  });
});

describe.skipIf(!anvilAvailable)("verifyOfferSignature", () => {
  let env: TestEnv;
  let offer: MandateOffer;
  beforeAll(async () => {
    env = await getEnv();
    const block = await env.publicClient.getBlock();
    offer = sampleOffer({
      creditorId: env.creditorId.prod,
      token: env.eurc,
      offerRef: refToBytes32("VERIFY-1"),
      validUntil: block.timestamp + 86_400n,
      debtor: ZERO_ADDRESS,
    });
  }, 120_000);

  const clientFor = (who: "creditor" | "operator" | "stranger") =>
    createRailClient({
      network: "arc",
      instance: "prod",
      publicClient: env.publicClient,
      walletClient: env.wallet(env.accounts[who]),
      addresses: { rail: env.prod.rail, lens: env.prod.lens },
    });

  test("accepts the creditor owner", async () => {
    const sig = await clientFor("creditor").signOffer(offer);
    const res = await verifyOfferSignature(env.publicClient, env.prod.rail, offer, sig);
    expect(res).toMatchObject({ valid: true, role: "owner" });
    expect(res.signer).toBe(env.accounts.creditor.address);
  });

  test("accepts an operator", async () => {
    const sig = await clientFor("operator").signOffer(offer);
    const res = await verifyOfferSignature(env.publicClient, env.prod.rail, offer, sig);
    expect(res).toMatchObject({ valid: true, role: "operator" });
  });

  test("rejects a stranger", async () => {
    const sig = await clientFor("stranger").signOffer(offer);
    const res = await verifyOfferSignature(env.publicClient, env.prod.rail, offer, sig);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/neither/);
  });

  test("rejects a signature over a tampered offer", async () => {
    const sig = await clientFor("creditor").signOffer(offer);
    const tampered = { ...offer, maxPerCollection: offer.maxPerCollection * 10n };
    const res = await verifyOfferSignature(env.publicClient, env.prod.rail, tampered, sig);
    expect(res.valid).toBe(false);
  });

  test("rejects malformed signatures", async () => {
    const res = await verifyOfferSignature(env.publicClient, env.prod.rail, offer, "0x1234");
    expect(res.valid).toBe(false);
  });

  test("rejects an offer made for the other instance's time scale", async () => {
    const sig = await clientFor("creditor").signOffer({ ...offer, timeScale: 10080 });
    const res = await verifyOfferSignature(env.publicClient, env.prod.rail, { ...offer, timeScale: 10080 }, sig);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/time scale/);
  });

  test("rejects an unknown creditor", async () => {
    const o = { ...offer, creditorId: 999n };
    const sig = await clientFor("creditor").signOffer(o);
    const res = await verifyOfferSignature(env.publicClient, env.prod.rail, o, sig);
    expect(res.valid).toBe(false);
  });
});

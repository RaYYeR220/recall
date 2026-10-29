import { beforeAll, describe, expect, test } from "bun:test";
import { createRailClient } from "../src/client";
import {
  decodeCheckoutLink,
  encodeCheckoutLink,
  verifyCheckoutLink,
  verifyOfferSignature,
  type CheckoutLinkPayload,
} from "../src/links";
import { mandateTextForOffer, refToBytes32, termsHash } from "../src/terms";
import { Scheme, ZERO_ADDRESS, type MandateOffer } from "../src/types";
import { sampleOffer } from "./fixtures";
import { anvilAvailable, getEnv, type TestEnv } from "./helpers";

const NAME = "Test Merchant"; // what helpers.ts registers on both rails

describe.skipIf(!anvilAvailable)("verifyCheckoutLink", () => {
  let env: TestEnv;
  let base: MandateOffer;
  let ref = 0;

  beforeAll(async () => {
    env = await getEnv();
    const block = await env.publicClient.getBlock();
    base = sampleOffer({
      creditorId: env.creditorId.prod,
      token: env.eurc,
      validUntil: block.timestamp + 86_400n,
    });
  }, 120_000);

  const textFor = (offer: MandateOffer, creditorName = NAME) =>
    mandateTextForOffer(offer, {
      creditorName,
      network: "arc",
      instance: "prod",
      rail: env.prod.rail,
      token: "EURC",
    });

  const signer = (who: "creditor" | "operator" | "stranger") =>
    createRailClient({
      network: "arc",
      instance: "prod",
      publicClient: env.publicClient,
      walletClient: env.wallet(env.accounts[who]),
      addresses: { rail: env.prod.rail, lens: env.prod.lens },
    });

  /**
   * Builds a signed link. `fields` change the offer; `textFrom` lets the text describe a DIFFERENT offer
   * than the one signed (the attack); `linkName` is the unauthenticated name carried in the link.
   */
  async function link(
    opts: {
      fields?: Partial<MandateOffer>;
      textFrom?: Partial<MandateOffer>;
      linkName?: string;
      chainNameInText?: string;
      by?: "creditor" | "operator" | "stranger";
    } = {},
  ): Promise<CheckoutLinkPayload> {
    const fields: MandateOffer = { ...base, offerRef: refToBytes32(`V-${++ref}`), ...opts.fields };
    const terms = textFor({ ...fields, ...opts.textFrom }, opts.chainNameInText ?? NAME);
    const offer = { ...fields, termsHash: termsHash(terms) };
    const offerSig = await signer(opts.by ?? "creditor").signOffer(offer);
    return {
      network: "arc",
      instance: "prod",
      offer,
      offerSig,
      creditorName: opts.linkName ?? NAME,
      terms,
    };
  }

  const verify = (p: CheckoutLinkPayload) => verifyCheckoutLink(env.publicClient, env.prod.rail, p);
  const codes = (r: Awaited<ReturnType<typeof verify>>) => r.problems.map((p) => p.code);

  test("an honest link is valid, and the name comes from the rail", async () => {
    const r = await verify(await link());
    expect(r.valid).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ nameMatches: true, textMatches: true, timeScaleMatches: true, creditorName: NAME });
    expect(r.signature).toMatchObject({ valid: true, role: "owner" });
  });

  test("an operator-signed honest link is valid", async () => {
    const r = await verify(await link({ by: "operator" }));
    expect(r.valid).toBe(true);
    expect(r.signature.role).toBe("operator");
  });

  describe("the creditor name in the link is not trusted", () => {
    test("a different name in the link is reported, the registered name is returned, and the link is not valid", async () => {
      const p = await link({ linkName: "Totally Legit Bank" });
      const r = await verify(p);
      expect(r.valid).toBe(false);
      expect(r.nameMatches).toBe(false);
      expect(r.creditorName).toBe(NAME);
      expect(r.creditorName).not.toBe(p.creditorName);
      expect(codes(r)).toEqual(["CreditorNameMismatch"]);
      expect(r.problems[0]?.message).toContain("Totally Legit Bank");
      // The signature and the text are fine: only the unauthenticated name is wrong.
      expect(r.signature.valid).toBe(true);
      expect(r.textMatches).toBe(true);
    });

    test("editing the name inside an encoded link still decodes, and verification catches it", async () => {
      const p = await link();
      const url = encodeCheckoutLink("https://recall.example/m", p);
      const u = new URL(url);
      const wire = JSON.parse(Buffer.from(u.hash.slice(3), "base64url").toString("utf8")) as Record<string, unknown>;
      wire["c"] = "Evil Corp";
      u.hash = `r=${Buffer.from(JSON.stringify(wire)).toString("base64url")}`;
      const decoded = decodeCheckoutLink(u.toString());
      expect(decoded.creditorName).toBe("Evil Corp"); // decoding cannot know
      const r = await verify(decoded);
      expect(r.valid).toBe(false);
      expect(codes(r)).toContain("CreditorNameMismatch");
    });

    test("a text that names a different creditor than the rail is a terms mismatch", async () => {
      const r = await verify(await link({ chainNameInText: "Someone Else" }));
      expect(r.valid).toBe(false);
      expect(codes(r)).toEqual(["TermsMismatch"]);
    });

    test("verifyOfferSignature returns the registered name", async () => {
      const p = await link();
      const res = await verifyOfferSignature(env.publicClient, env.prod.rail, p.offer, p.offerSig);
      expect(res).toMatchObject({ valid: true, creditorName: NAME });
    });
  });

  describe("the text must describe the offer's own fields", () => {
    test("a text promising a refund on a B2B offer is rejected", async () => {
      const p = await link({ fields: { scheme: Scheme.B2B }, textFrom: { scheme: Scheme.CORE } });
      expect(p.terms).toContain("full refund"); // the lie
      const r = await verify(p);
      expect(r.valid).toBe(false);
      expect(r.textMatches).toBe(false);
      expect(codes(r)).toEqual(["TermsMismatch"]);
      expect(r.signature.valid).toBe(true); // hash and signature are consistent: only text vs fields disagree
      expect(r.expectedTerms).toContain("No refund right");
    });

    const lies: [string, Partial<MandateOffer>, Partial<MandateOffer>][] = [
      ["a higher cap than the text says", { maxPerCollection: 500_000_000n }, { maxPerCollection: 100_000_000n }],
      ["a higher period cap than the text says", { maxPerPeriod: 900_000_000n }, { maxPerPeriod: 200_000_000n }],
      ["a shorter notice than the text says", { prenoticeLength: 3_600 }, { prenoticeLength: 86_400 }],
      ["a shorter period than the text says", { periodLength: 86_400 }, { periodLength: 30 * 86_400 }],
      ["repeating when the text says one-off", { oneOff: false }, { oneOff: true }],
      ["unlimited uses when the text says one use", { maxUses: 0 }, { maxUses: 1 }],
      ["a later expiry than the text says", { validUntil: 1_900_100_000n }, { validUntil: 1_900_000_000n }],
      ["an open offer when the text names a payer", { debtor: ZERO_ADDRESS }, { debtor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }],
      ["a bound payer when the text says anyone", { debtor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }, { debtor: ZERO_ADDRESS }],
    ];
    for (const [name, fields, textFrom] of lies) {
      test(`rejects ${name}`, async () => {
        const r = await verify(await link({ fields, textFrom }));
        expect(r.valid).toBe(false);
        expect(codes(r)).toEqual(["TermsMismatch"]);
      });
    }

    test("a single changed character is enough", async () => {
      const p = await link();
      // Re-sign a text with one extra space; the hash binds it, so only the text-vs-fields rule can catch it.
      const terms = `${p.terms} `;
      const offer = { ...p.offer, termsHash: termsHash(terms) };
      const offerSig = await signer("creditor").signOffer(offer);
      const r = await verify({ ...p, offer, offerSig, terms });
      expect(codes(r)).toEqual(["TermsMismatch"]);
    });
  });

  describe("everything else the link asserts", () => {
    test("an offer for the other instance's time scale is rejected", async () => {
      const r = await verify(await link({ fields: { timeScale: 10080 } }));
      expect(r.valid).toBe(false);
      expect(r.timeScaleMatches).toBe(false);
      expect(codes(r)).toContain("WrongTimeScale");
    });

    test("a signature by a stranger is rejected", async () => {
      const r = await verify(await link({ by: "stranger" }));
      expect(r.valid).toBe(false);
      expect(codes(r)).toEqual(["BadSignature"]);
    });

    test("a token the rail does not accept is rejected", async () => {
      const p = await link({ fields: { token: "0x00000000000000000000000000000000000000aa" } });
      const r = await verify(p);
      expect(r.valid).toBe(false);
      expect(codes(r)).toContain("TokenNotAllowed");
    });

    test("an unknown creditor is rejected and has no name", async () => {
      const r = await verify(await link({ fields: { creditorId: 999n } }));
      expect(r.valid).toBe(false);
      expect(r.creditorName).toBeUndefined();
      expect(codes(r)).toEqual(["UnknownCreditor"]);
    });
  });
});

describe("mandateTextForOffer", () => {
  const ctx = { creditorName: NAME, network: "arc", instance: "prod", rail: "0x8a91eB44cF5d213C2230A42D1DF84585224075B0", token: "EURC" } as const;

  test("is a pure function of the offer fields and the name", () => {
    const o = sampleOffer();
    expect(mandateTextForOffer(o, ctx)).toBe(mandateTextForOffer({ ...o }, ctx));
  });

  test("every limit in the offer shows up in the text", () => {
    const t = mandateTextForOffer(
      sampleOffer({ maxPerCollection: 25_500_000n, maxPerPeriod: 99_000_000n, maxUses: 3, oneOff: true, scheme: Scheme.B2B }),
      ctx,
    );
    expect(t).toContain("25.50 EURC per collection");
    expect(t).toContain("99.00 EURC");
    expect(t).toContain("accepted at most 3 times");
    expect(t).toContain("One collection only");
    expect(t).toContain("No refund right");
  });

  test("the offer reference is shown as text when it is printable", () => {
    expect(mandateTextForOffer(sampleOffer({ offerRef: refToBytes32("NW-PROD-001") }), ctx)).toContain("Reference: NW-PROD-001");
  });
});

import { beforeAll, describe, expect, test } from "bun:test";
import { hashTypedData, keccak256, toHex, type Hex } from "viem";
import { debitRailAbi } from "../src/abi";
import {
  acceptanceTypedData,
  debtorActionTypedData,
  offerTypedData,
  permitTypedData,
  railDomain,
} from "../src/eip712";
import { ActionKind } from "../src/types";
import { offerVariants, rejection } from "./fixtures";
import { anvilAvailable, getEnv, type TestEnv } from "./helpers";

describe.skipIf(!anvilAvailable)("EIP-712 typed data matches the contract", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await getEnv();
  }, 120_000);

  for (const instance of ["prod", "demo"] as const) {
    describe(`${instance} rail`, () => {
      test("railDomain reads the name from the contract", async () => {
        const d = await railDomain(env.publicClient, env[instance].rail);
        expect(d.name).toBe(instance === "prod" ? "Recall DebitRail" : "Recall DebitRail DEMO (1 week = 1 minute)");
        expect(d.version).toBe("1");
        expect(d.verifyingContract.toLowerCase()).toBe(env[instance].rail.toLowerCase());
        expect(d.chainId).toBe(31337);
      });

      test("offer digest equals hashOffer for every field combination", async () => {
        const rail = env[instance].rail;
        const domain = await railDomain(env.publicClient, rail);
        const offers = offerVariants({
          creditorId: env.creditorId[instance],
          token: env.eurc,
          debtor: env.accounts.debtor.address,
        });
        for (const offer of offers) {
          const onchain = await env.publicClient.readContract({
            address: rail,
            abi: debitRailAbi,
            functionName: "hashOffer",
            args: [offer],
          });
          expect(hashTypedData(offerTypedData(domain, offer))).toBe(onchain);
        }
      });

      test("acceptance digest equals hashAcceptance", async () => {
        const rail = env[instance].rail;
        const domain = await railDomain(env.publicClient, rail);
        const accs = [
          { offerHash: keccak256(toHex("a")), debtor: env.accounts.debtor.address, deadline: 1_900_000_000n },
          { offerHash: keccak256(toHex("b")), debtor: env.accounts.stranger.address, deadline: (1n << 64n) - 1n },
        ];
        for (const acc of accs) {
          const onchain = await env.publicClient.readContract({
            address: rail,
            abi: debitRailAbi,
            functionName: "hashAcceptance",
            args: [acc],
          });
          expect(hashTypedData(acceptanceTypedData(domain, acc))).toBe(onchain);
        }
      });

      test("debtor action digest equals hashDebtorAction for REFUND, REVOKE and REFUSE", async () => {
        const rail = env[instance].rail;
        const domain = await railDomain(env.publicClient, rail);
        for (const kind of Object.values(ActionKind)) {
          const action = { kind, target: keccak256(toHex(`t${kind}`)), nonce: BigInt(kind) + 5n, deadline: 1_900_000_000n };
          const onchain = await env.publicClient.readContract({
            address: rail,
            abi: debitRailAbi,
            functionName: "hashDebtorAction",
            args: [action],
          });
          expect(hashTypedData(debtorActionTypedData(domain, action))).toBe(onchain);
        }
      });
    });
  }

  test("the two instances sign over different domains", async () => {
    const [p, d] = await Promise.all([
      railDomain(env.publicClient, env.prod.rail),
      railDomain(env.publicClient, env.demo.rail),
    ]);
    const offer = offerVariants({ creditorId: 1n, token: env.eurc, debtor: env.accounts.debtor.address })[0];
    expect(hashTypedData(offerTypedData(p, offer))).not.toBe(hashTypedData(offerTypedData(d, offer)));
  });

  test("permitTypedData reproduces the token's DOMAIN_SEPARATOR and carries the live nonce", async () => {
    const typed = await permitTypedData(
      env.publicClient,
      env.eurc,
      env.accounts.debtor.address,
      env.prod.rail,
      500_000_000n,
      1_900_000_000n,
    );
    expect(typed.primaryType).toBe("Permit");
    expect(typed.domain.verifyingContract.toLowerCase()).toBe(env.eurc.toLowerCase());
    expect(typed.message.nonce).toBe(0n);
    expect(typed.message.spender).toBe(env.prod.rail);
  });

  test("permitTypedData refuses a contract it cannot verify", async () => {
    // The rail has nonces(address) but no DOMAIN_SEPARATOR(), so the permit domain cannot be checked.
    const err = await rejection(
      permitTypedData(env.publicClient, env.prod.rail, env.accounts.debtor.address, env.prod.rail, 1n, 2n),
    );
    expect(err.message).toMatch(/DOMAIN_SEPARATOR/);
  });

  test("digests are 32 bytes of hex", () => {
    const d: Hex = hashTypedData(
      offerTypedData(
        { name: "x", version: "1", chainId: 1, verifyingContract: env.prod.rail },
        offerVariants({ creditorId: 1n, token: env.eurc, debtor: env.accounts.debtor.address })[0],
      ),
    );
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

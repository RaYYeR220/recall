import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRailClient } from "../src/client";
import {
  MEMO_ADDRESS,
  TIME_SCALE,
  networkInfo,
  railAddresses,
  tokenByAddress,
  txUrl,
  type RailNetwork,
} from "../src/networks";

const deployment = (id: number) =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "deployments", `${id}.json`), "utf8")) as {
    prod: { rail: string; lens: string };
    demo: { rail: string; lens: string };
  };

describe("networks", () => {
  test("chain definitions", () => {
    expect(networkInfo("arc")).toMatchObject({
      chainId: 5042,
      rpcUrl: "https://rpc.mainnet.arc.io",
      explorer: "https://explorer.arc.io",
    });
    expect(networkInfo("arc-testnet")).toMatchObject({
      chainId: 5042002,
      rpcUrl: "https://rpc.testnet.arc.io",
      explorer: "https://explorer.testnet.arc.io",
    });
    expect(networkInfo("arc").chain.id).toBe(5042);
    expect(networkInfo("arc-testnet").chain.id).toBe(5042002);
  });

  test("token addresses and decimals", () => {
    expect(networkInfo("arc").eurc.address).toBe("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1");
    expect(networkInfo("arc-testnet").eurc.address).toBe("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
    for (const n of ["arc", "arc-testnet"] as RailNetwork[]) {
      expect(networkInfo(n).usdc.address).toBe("0x3600000000000000000000000000000000000000");
      expect(networkInfo(n).usdc.decimals).toBe(6);
      expect(networkInfo(n).eurc.decimals).toBe(6);
    }
    expect(tokenByAddress("arc", "0x3600000000000000000000000000000000000000")?.symbol).toBe("USDC");
    expect(tokenByAddress("arc", "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")).toBeUndefined();
  });

  test("rail and lens addresses come from the deployment files", () => {
    for (const [network, id] of [["arc", 5042], ["arc-testnet", 5042002]] as const) {
      const json = deployment(id);
      const a = railAddresses(network);
      expect(a.prod.rail.toLowerCase()).toBe(json.prod.rail.toLowerCase());
      expect(a.prod.lens.toLowerCase()).toBe(json.prod.lens.toLowerCase());
      expect(a.demo.rail.toLowerCase()).toBe(json.demo.rail.toLowerCase());
      expect(a.demo.lens.toLowerCase()).toBe(json.demo.lens.toLowerCase());
    }
    expect(railAddresses("arc").prod.rail).not.toBe(railAddresses("arc-testnet").prod.rail);
  });

  test("a client defaults to the deployed addresses and instance time scale", () => {
    const c = createRailClient({ network: "arc", instance: "demo", publicClient: {} as never });
    expect(c.rail).toBe(railAddresses("arc").demo.rail);
    expect(c.lens).toBe(railAddresses("arc").demo.lens);
    expect(c.timeScale).toBe(TIME_SCALE.demo);
    expect(TIME_SCALE).toEqual({ prod: 1, demo: 10080 });
  });

  test("explorer link and memo predeploy", () => {
    expect(txUrl("arc", "0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
    expect(MEMO_ADDRESS).toBe("0x5294E9927c3306DcBaDb03fe70b92e01cCede505");
  });

  test("unknown networks are rejected", () => {
    expect(() => networkInfo("base" as RailNetwork)).toThrow(/Unknown Recall network/);
  });
});

import { formatUnits, type Hex } from "viem";
import { e2eIdText } from "../../sdk/src/index.js";

/** 6-decimal token amount as a plain decimal string, for example "12.5". */
export const fmt = (v: bigint): string => formatUnits(v, 6);

export const iso = (unixSeconds: bigint | number): string => new Date(Number(unixSeconds) * 1000).toISOString();

/** JSON that survives bigint (as decimal strings). */
export const toJson = (value: unknown): string => JSON.stringify(value, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

/** A bytes32 reference as the readable text the merchant wrote, or the hex when it is not text. */
export const refOf = (b: Hex): string => e2eIdText(b);

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const units: [string, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? "" : "s"}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(" ") : "0 seconds";
}

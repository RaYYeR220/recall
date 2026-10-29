/** The widest block range one eth_getLogs call should ask for. */
export const LOG_WINDOW = 9_000n;

/** Inclusive `[from, to]` ranges that cover `fromBlock..toBlock` in steps of at most `size` blocks. */
export function blockWindows(fromBlock: bigint, toBlock: bigint, size: bigint = LOG_WINDOW): [bigint, bigint][] {
  if (size <= 0n) throw new Error("window size must be positive");
  const out: [bigint, bigint][] = [];
  for (let from = fromBlock; from <= toBlock; from += size) {
    const to = from + size - 1n;
    out.push([from, to > toBlock ? toBlock : to]);
  }
  return out;
}

/**
 * Runs `fetchWindow` over every window with a bounded number in flight, and returns the results in block
 * order. Paginating this way keeps each request inside a node's range limit.
 */
export async function scanWindows<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetchWindow: (from: bigint, to: bigint) => Promise<T[]>,
  opts: { size?: bigint; concurrency?: number } = {},
): Promise<T[]> {
  const windows = blockWindows(fromBlock, toBlock, opts.size);
  const results: T[][] = new Array<T[]>(windows.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, windows.length)) }, async () => {
    for (;;) {
      const i = next++;
      const w = windows[i];
      if (!w) return;
      results[i] = await fetchWindow(w[0], w[1]);
    }
  });
  await Promise.all(workers);
  return results.flat();
}

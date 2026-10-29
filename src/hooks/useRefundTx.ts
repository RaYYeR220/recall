import { useQuery } from '@tanstack/react-query'
import { parseAbiItem, type Hex } from 'viem'
import { deploymentBlock, railAddresses, type RailInstance, type RailNetwork } from '@recall/sdk'
import { getPublicClient } from '@/lib/clients'

const REFUNDED = parseAbiItem('event CollectionRefunded(bytes32 indexed collectionId, uint128 amount)')
const CHUNK = 9_000n
const MAX_CHUNKS = 14

/**
 * Finds the transaction that refunded a collection. The RPC caps eth_getLogs ranges, so this walks forward in
 * bounded chunks starting just before the debit settled (never from block 0), and gives up quietly if it cannot.
 */
export function useRefundTx(
  network: RailNetwork,
  instance: RailInstance,
  collectionId: Hex | undefined,
  settledAt: number | undefined,
  enabled: boolean,
) {
  return useQuery({
    enabled: enabled && !!collectionId && !!settledAt,
    queryKey: ['refund-tx', network, instance, collectionId],
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<Hex | null> => {
      if (!collectionId || !settledAt) return null
      const pc = getPublicClient(network)
      const rail = railAddresses(network)[instance].rail
      const head = await pc.getBlock()
      const sample = await pc.getBlock({ blockNumber: head.number - 20_000n })
      const secPerBlock = Math.max(0.05, Number(head.timestamp - sample.timestamp) / 20_000)
      const blocksAgo = BigInt(Math.ceil((Number(head.timestamp) - settledAt) / secPerBlock)) + 2_000n
      const floor = deploymentBlock(network)
      let from = head.number - blocksAgo
      if (from < floor) from = floor
      for (let i = 0; i < MAX_CHUNKS && from <= head.number; i++) {
        const to = from + CHUNK > head.number ? head.number : from + CHUNK
        const logs = await pc.getLogs({ address: rail, event: REFUNDED, args: { collectionId }, fromBlock: from, toBlock: to })
        const hit = logs[0]
        if (hit) return hit.transactionHash
        from = to + 1n
      }
      return null
    },
  })
}

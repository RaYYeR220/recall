import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RailNetwork } from '@recall/sdk'
import { getPublicClient } from './clients'

/**
 * Chain time, ticking every second. Windows on the demo rail are minutes long, so the clock the
 * countdowns use is the chain's own (latest block timestamp), not the browser's.
 */
export function useChainNow(network: RailNetwork): { now: number; ready: boolean; blockNumber?: bigint } {
  const { data } = useQuery({
    queryKey: ['chain-clock', network],
    queryFn: async () => {
      const block = await getPublicClient(network).getBlock()
      return { timestamp: Number(block.timestamp), number: block.number, localAt: Date.now() }
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  })
  const skew = data ? data.timestamp - data.localAt / 1000 : 0
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return { now: Math.floor(tick / 1000 + skew), ready: !!data, blockNumber: data?.number }
}

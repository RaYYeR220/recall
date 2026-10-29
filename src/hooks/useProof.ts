import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { debitRailAbi, railAddresses, tokenBySymbol, type RailInstance, type RailNetwork } from '@recall/sdk'
import { readRail } from '@/hooks/useWallet'
import { getPublicClient } from '@/lib/clients'

export const PROOF_NETWORK: RailNetwork = 'arc'
const REFRESH_MS = 15_000

/** RailLens.health() for one instance, refreshed every 15 seconds. */
export function useLiveHealth(instance: RailInstance) {
  return useQuery({
    queryKey: ['proof-health', PROOF_NETWORK, instance],
    queryFn: async () => {
      const [health, block] = await Promise.all([readRail(PROOF_NETWORK, instance).health(), getPublicClient(PROOF_NETWORK).getBlockNumber()])
      return { health, block, at: Date.now() }
    },
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS - 1000,
    retry: 2,
  })
}

export interface TokenStats {
  collected: bigint
  refunded: bigint
  settledCount: bigint
  refundedCount: bigint
  returnedCount: bigint
}

/** DebitRail.stats(token) for EURC and USDC. */
export function useStats(instance: RailInstance) {
  return useQuery({
    queryKey: ['proof-stats', PROOF_NETWORK, instance],
    queryFn: async () => {
      const pc = getPublicClient(PROOF_NETWORK)
      const rail = railAddresses(PROOF_NETWORK)[instance].rail
      const read = async (token: Address): Promise<TokenStats> => {
        const [collected, refunded, settledCount, refundedCount, returnedCount] = await pc.readContract({
          address: rail,
          abi: debitRailAbi,
          functionName: 'stats',
          args: [token],
        })
        return { collected, refunded, settledCount, refundedCount, returnedCount }
      }
      const [eurc, usdc] = await Promise.all([read(tokenBySymbol(PROOF_NETWORK, 'EURC').address), read(tokenBySymbol(PROOF_NETWORK, 'USDC').address)])
      return { eurc, usdc }
    },
    refetchInterval: REFRESH_MS,
    staleTime: REFRESH_MS - 1000,
    retry: 2,
  })
}

export type SourcifyState = { state: 'perfect' | 'partial' | 'unverified' | 'unreachable' }

/** Whether Sourcify holds verified source for an address on this chain. */
export function useSourcify(address: string, chainId: number) {
  return useQuery({
    queryKey: ['sourcify', chainId, address],
    queryFn: async (): Promise<SourcifyState> => {
      try {
        const res = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`)
        if (res.status === 404) return { state: 'unverified' }
        if (!res.ok) return { state: 'unreachable' }
        const json = (await res.json()) as { match?: string }
        if (json.match === 'exact_match') return { state: 'perfect' }
        if (json.match === 'match') return { state: 'partial' }
        return { state: 'unverified' }
      } catch {
        return { state: 'unreachable' }
      }
    },
    staleTime: 10 * 60_000,
    retry: 0,
  })
}

export interface LedgerEntry {
  label: string
  kind: 'action' | 'refusal'
  rail: 'prod' | 'demo'
  hash: string
  error?: string
}

/** The hero transactions, from public/proof.json. */
export function useLedger() {
  return useQuery({
    queryKey: ['proof-ledger'],
    queryFn: async (): Promise<{ explorer: string; entries: LedgerEntry[] }> => {
      const res = await fetch('/proof.json', { cache: 'no-cache' })
      if (!res.ok) throw new Error(`proof.json answered ${res.status}`)
      const json = (await res.json()) as { explorer?: string; entries?: LedgerEntry[] }
      if (!Array.isArray(json.entries)) throw new Error('proof.json has no entries')
      return { explorer: json.explorer ?? 'https://explorer.arc.io', entries: json.entries }
    },
    staleTime: 60_000,
    retry: 1,
  })
}

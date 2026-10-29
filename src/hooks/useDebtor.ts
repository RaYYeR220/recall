import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { debitRailAbi, type RailInstance, type RailNetwork } from '@recall/sdk'
import { readRail } from '@/hooks/useWallet'
import { getPublicClient } from '@/lib/clients'
import type { Windows } from '@/lib/model'

export const MANDATE_PAGE = 8

/** A payer's mandates (RailLens.debtorView), a page at a time, each with its newest collections. */
export function useDebtorMandates(network: RailNetwork, instance: RailInstance, who: Address | undefined) {
  return useInfiniteQuery({
    enabled: !!who,
    queryKey: ['debtor', network, instance, who],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      if (!who) throw new Error('no address')
      return readRail(network, instance).debtorView(who, pageParam, MANDATE_PAGE)
    },
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.views.length, 0)
      return loaded < Number(last.total) ? loaded : undefined
    },
    refetchInterval: 15_000,
    staleTime: 8_000,
  })
}

/** Full collection history (RailLens.collectionsPage) for mandates with more than the lens's inline 10. */
export function useFullHistories(network: RailNetwork, instance: RailInstance, mandateIds: Hex[]) {
  return useQueries({
    queries: mandateIds.map((id) => ({
      queryKey: ['full-history', network, instance, id],
      queryFn: () => readRail(network, instance).collectionsPage(id, 0, 0),
      refetchInterval: 20_000,
    })),
  })
}

export function useWindows(network: RailNetwork, instance: RailInstance) {
  return useQuery({
    queryKey: ['windows', network, instance],
    queryFn: (): Promise<Windows> => readRail(network, instance).windows(),
    staleTime: Infinity,
  })
}

export function useCreditorNames(network: RailNetwork, instance: RailInstance, ids: bigint[]) {
  const key = [...new Set(ids.map((i) => i.toString()))].sort().join(',')
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ['creditor-names', network, instance, key],
    queryFn: async () => {
      const rail = readRail(network, instance).rail
      const pc = getPublicClient(network)
      const unique = [...new Set(ids)]
      const rows = await Promise.all(
        unique.map(async (id) => {
          const c = await pc.readContract({ address: rail, abi: debitRailAbi, functionName: 'getCreditor', args: [id] })
          return [id.toString(), c.name] as const
        }),
      )
      return Object.fromEntries(rows)
    },
    staleTime: 5 * 60_000,
  })
}

export function useLapsed(network: RailNetwork, instance: RailInstance, mandateIds: Hex[]) {
  return useQueries({
    queries: mandateIds.map((id) => ({
      queryKey: ['lapsed', network, instance, id],
      queryFn: () =>
        getPublicClient(network).readContract({
          address: readRail(network, instance).rail,
          abi: debitRailAbi,
          functionName: 'isLapsed',
          args: [id],
        }),
      staleTime: 30_000,
    })),
  })
}

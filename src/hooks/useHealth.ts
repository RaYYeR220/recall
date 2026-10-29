import { useQuery } from '@tanstack/react-query'
import type { RailInstance, RailNetwork } from '@recall/sdk'
import { readRail } from '@/hooks/useWallet'

/** Solvency figures straight from RailLens.health(). */
export function useHealth(network: RailNetwork, instance: RailInstance) {
  return useQuery({
    queryKey: ['health', network, instance],
    queryFn: () => readRail(network, instance).health(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 2,
  })
}

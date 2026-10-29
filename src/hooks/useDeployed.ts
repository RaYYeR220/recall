import { useQuery } from '@tanstack/react-query'
import { railAddresses, type RailInstance, type RailNetwork } from '@recall/sdk'
import { getPublicClient } from '@/lib/clients'

/** Whether there is contract code at the rail address recorded in deployments/*.json. `undefined` while checking. */
export function useDeployed(network: RailNetwork, instance: RailInstance) {
  return useQuery({
    queryKey: ['deployed', network, instance],
    queryFn: async () => {
      const code = await getPublicClient(network).getCode({ address: railAddresses(network)[instance].rail })
      return !!code && code !== '0x'
    },
    staleTime: 60_000,
    retry: 1,
  })
}

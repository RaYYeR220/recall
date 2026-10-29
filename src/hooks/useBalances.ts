import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { erc20Abi, networkInfo, railAddresses, RAIL_INSTANCES, type RailInstance, type RailNetwork } from '@recall/sdk'
import { getPublicClient } from '@/lib/clients'

export interface WalletFigures {
  eurc: bigint
  usdc: bigint
  allowance: Record<RailInstance, { eurc: bigint; usdc: bigint }>
}

/** ERC-20 view of the wallet's EURC and USDC (on Arc the gas token is the same USDC pool: shown once), plus allowances per rail. */
export function useWalletFigures(network: RailNetwork, owner: Address | undefined) {
  return useQuery({
    enabled: !!owner,
    queryKey: ['wallet-figures', network, owner],
    queryFn: async (): Promise<WalletFigures> => {
      if (!owner) throw new Error('no owner')
      const info = networkInfo(network)
      const pc = getPublicClient(network)
      const addrs = railAddresses(network)
      const bal = (token: Address) => pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
      const allow = (token: Address, spender: Address) =>
        pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })

      const [eurc, usdc, ...allowances] = await Promise.all([
        bal(info.eurc.address),
        bal(info.usdc.address),
        ...RAIL_INSTANCES.flatMap((i) => [allow(info.eurc.address, addrs[i].rail), allow(info.usdc.address, addrs[i].rail)]),
      ])
      const allowance = {} as WalletFigures['allowance']
      RAIL_INSTANCES.forEach((i, idx) => {
        allowance[i] = { eurc: allowances[idx * 2] ?? 0n, usdc: allowances[idx * 2 + 1] ?? 0n }
      })
      return { eurc, usdc, allowance }
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  })
}

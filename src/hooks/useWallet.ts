import { useMemo } from 'react'
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi'
import { createRailClient, type RailInstance } from '@recall/sdk'
import { getPublicClient, RELAY_URL } from '@/lib/clients'
import { useNetwork } from '@/lib/network'

/** The connected wallet, relative to the network the app is showing. */
export function useWallet() {
  const { info } = useNetwork()
  const { address, isConnected, chainId } = useAccount()
  const { data: walletClient } = useWalletClient({ chainId: info.chainId })
  const { switchChainAsync, isPending: switching } = useSwitchChain()

  const wrongChain = isConnected && chainId !== info.chainId

  async function ensureChain(): Promise<void> {
    if (isConnected && chainId !== info.chainId) await switchChainAsync({ chainId: info.chainId })
  }

  return { address, isConnected, walletChainId: chainId, wrongChain, walletClient, ensureChain, switching }
}

/** An SDK client for one instance on the app's network, with the wallet attached when there is one. */
export function useRail(instance: RailInstance) {
  const { network } = useNetwork()
  const { walletClient } = useWallet()
  return useMemo(
    () =>
      createRailClient({
        network,
        instance,
        publicClient: getPublicClient(network),
        walletClient,
        relayUrl: RELAY_URL,
      }),
    [network, instance, walletClient],
  )
}

/** A read-only client for an explicit network (the mandate page follows the link, not the badge). */
export function readRail(network: Parameters<typeof getPublicClient>[0], instance: RailInstance) {
  return createRailClient({ network, instance, publicClient: getPublicClient(network) })
}

import { createPublicClient, http, type PublicClient } from 'viem'
import { networkInfo, type RailNetwork } from '@recall/sdk'

const cache = new Map<RailNetwork, PublicClient>()

/** One read-only client per network. Every read in the app goes through these: no mock data. */
export function getPublicClient(network: RailNetwork): PublicClient {
  let c = cache.get(network)
  if (!c) {
    const info = networkInfo(network)
    c = createPublicClient({ chain: info.chain, transport: http(info.rpcUrl) })
    cache.set(network, c)
  }
  return c
}

/** The relay is a server function that comes later. The client calls it and handles it being absent. */
export const RELAY_URL = '/api/relay'

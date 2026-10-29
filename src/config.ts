/**
 * wagmi configuration: Arc mainnet and Arc testnet only.
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { arcMainnet, arcTestnet } from '@recall/sdk'
import { registerChain } from './studio-bridge'

const MAINNET_RPC = arcMainnet.rpcUrls.default.http[0]
const TESTNET_RPC = arcTestnet.rpcUrls.default.http[0]

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcMainnet.id, MAINNET_RPC)
registerChain(arcTestnet.id, TESTNET_RPC)

export const config = createConfig({
  chains: [arcMainnet, arcTestnet],
  connectors: [injected()],
  transports: {
    [arcMainnet.id]: http(MAINNET_RPC),
    [arcTestnet.id]: http(TESTNET_RPC),
  },
})

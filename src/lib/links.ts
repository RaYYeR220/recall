import { addressUrl, type RailNetwork } from '@recall/sdk'

export const buildAddressUrl = (network: RailNetwork, address: string) => addressUrl(network, address)

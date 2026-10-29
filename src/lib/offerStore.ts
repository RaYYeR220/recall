import type { Address } from 'viem'
import type { RailInstance, RailNetwork } from '@recall/sdk'

/** Offers created in this browser. Only the checkout token is kept: it carries everything and is re-verified on read. */
export interface StoredOffer {
  token: string
  createdAt: number
}

const key = (network: RailNetwork, instance: RailInstance, creditorId: bigint, wallet: Address) =>
  `recall.offers.${network}.${instance}.${creditorId}.${wallet.toLowerCase()}`

export function loadOffers(network: RailNetwork, instance: RailInstance, creditorId: bigint, wallet: Address): StoredOffer[] {
  try {
    const raw = window.localStorage.getItem(key(network, instance, creditorId, wallet))
    const list = raw ? (JSON.parse(raw) as StoredOffer[]) : []
    return Array.isArray(list) ? list.filter((o) => typeof o.token === 'string' && typeof o.createdAt === 'number') : []
  } catch {
    return []
  }
}

export function saveOffers(network: RailNetwork, instance: RailInstance, creditorId: bigint, wallet: Address, list: StoredOffer[]): void {
  try {
    window.localStorage.setItem(key(network, instance, creditorId, wallet), JSON.stringify(list.slice(0, 50)))
  } catch {
    /* storage can be blocked or full: the link was already shown to the merchant */
  }
}

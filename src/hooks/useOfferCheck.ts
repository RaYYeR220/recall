import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import {
  debitRailAbi,
  tokenByAddress,
  verifyCheckoutLink,
  type CheckoutLinkPayload,
  type CheckoutVerification,
  type OfferSignatureResult,
  type TokenInfo,
} from '@recall/sdk'
import { getPublicClient } from '@/lib/clients'
import { readRail } from '@/hooks/useWallet'

export interface OfferCheck {
  signature: OfferSignatureResult
  /** Signature, registered name, text-vs-fields and time-scale checks, all against the rail. */
  verification: CheckoutVerification
  creditor: { owner: Address; payout: Address; name: string } | null
  offerHash: Hex
  cancelled: boolean
  uses: number
  chainTime: number
  token: TokenInfo | undefined
  windows: { refundWindow: bigint; minPrenotice: bigint; lapsePeriod: bigint }
  blockNumber: bigint
}

/** Everything the mandate page checks against the chain before it lets anyone sign. */
export function useOfferCheck(payload: CheckoutLinkPayload | null) {
  return useQuery({
    enabled: !!payload,
    queryKey: ['offer-check', payload?.network, payload?.instance, payload?.offerSig, payload?.offer.termsHash, payload?.offer.offerRef],
    queryFn: async (): Promise<OfferCheck> => {
      if (!payload) throw new Error('no link')
      const { network, instance, offer } = payload
      const rail = readRail(network, instance)
      const pc = getPublicClient(network)

      const [verification, offerHash, block, windows] = await Promise.all([
        verifyCheckoutLink(pc, rail.rail, payload),
        rail.offerHash(offer),
        pc.getBlock(),
        rail.windows(),
      ])
      const [cancelled, uses, creditor] = await Promise.all([
        pc.readContract({ address: rail.rail, abi: debitRailAbi, functionName: 'offerCancelled', args: [offerHash] }),
        pc.readContract({ address: rail.rail, abi: debitRailAbi, functionName: 'offerUses', args: [offerHash] }),
        pc
          .readContract({ address: rail.rail, abi: debitRailAbi, functionName: 'getCreditor', args: [offer.creditorId] })
          .then((c) => (c.owner === '0x0000000000000000000000000000000000000000' ? null : c))
          .catch(() => null),
      ])
      return {
        signature: verification.signature,
        verification,
        creditor,
        offerHash,
        cancelled,
        uses,
        chainTime: Number(block.timestamp),
        token: tokenByAddress(network, offer.token),
        windows: {
          refundWindow: windows.refundWindow,
          minPrenotice: windows.minPrenotice,
          lapsePeriod: windows.lapsePeriod,
        },
        blockNumber: block.number,
      }
    },
    staleTime: 20_000,
    retry: 1,
  })
}

import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { CheckoutLinkPayload } from '@recall/sdk'
import { readRail } from '@/hooks/useWallet'

/** Whether this wallet has already accepted this exact offer (mandateId = hash(offerHash, debtor)). */
export function useExistingMandate(payload: CheckoutLinkPayload | null, debtor: Address | undefined) {
  return useQuery({
    enabled: !!payload && !!debtor,
    queryKey: ['existing-mandate', payload?.network, payload?.instance, payload?.offerSig, payload?.offer.offerRef, debtor],
    queryFn: async () => {
      if (!payload || !debtor) throw new Error('missing')
      const rail = readRail(payload.network, payload.instance)
      const mandateId = await rail.mandateId(payload.offer, debtor)
      const mandate = await rail.getMandate(mandateId)
      return { mandateId, status: mandate.status }
    },
    staleTime: 10_000,
  })
}

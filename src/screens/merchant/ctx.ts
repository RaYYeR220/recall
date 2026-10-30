import { createContext, useContext } from 'react'
import type { Address } from 'viem'
import type { RailInstance } from '@recall/sdk'
import type { CreditorRef } from '@/hooks/useMerchant'

export interface MerchantCtx {
  instance: RailInstance
  creditor: CreditorRef
  wallet: Address
  /** The wallet may withdraw, change operators and pay out. Operators cannot. */
  isOwner: boolean
  /** Disabled reason for write buttons (wrong chain, no wallet), or undefined when ready. */
  gate: string | undefined
  /** A read-only view of someone else's creditor (a ?watch= link): no wallet, every write is disabled. */
  readOnly?: boolean
}

export const MerchantContext = createContext<MerchantCtx | null>(null)

export function useMerchantCtx(): MerchantCtx {
  const ctx = useContext(MerchantContext)
  if (!ctx) throw new Error('useMerchantCtx must be used inside the merchant console')
  return ctx
}

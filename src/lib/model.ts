import type { Address, Hex } from 'viem'
import {
  CollectionStatus,
  decodeReturnCode,
  MandateStatus,
  Scheme,
  tokenByAddress,
  type RailInstance,
  type RailNetwork,
} from '@recall/sdk'
import type { RailClient } from '@recall/sdk'
import type { TokenSymbol } from './format'

type DebtorView = Awaited<ReturnType<RailClient['debtorView']>>['views'][number]
export type MandateRecord = DebtorView['mandate']
export type TokenSymbolLike = TokenSymbol
export type CollectionRecord = DebtorView['collections'][number]

export interface Windows {
  refundWindow: bigint
  minPrenotice: bigint
  executionWindow: bigint
  lapsePeriod: bigint
  scheduleAhead: bigint
}

export interface DebitItem {
  key: string
  instance: RailInstance
  collectionId: Hex
  mandateId: Hex
  mandate: MandateRecord
  collection: CollectionRecord
  creditorName: string
  symbol: TokenSymbol
}

export type Bucket = 'upcoming' | 'refundable' | 'history'

export function symbolOf(network: RailNetwork, token: Address): TokenSymbol {
  return tokenByAddress(network, token)?.symbol ?? 'USDC'
}

export function refundDeadlineOf(item: DebitItem, w: Windows): number {
  return Number(item.collection.settledAt) + Number(w.refundWindow)
}

export function bucketOf(item: DebitItem, now: number, w: Windows): Bucket {
  const c = item.collection
  if (c.status === CollectionStatus.SCHEDULED) return 'upcoming'
  if (c.status === CollectionStatus.SETTLED && item.mandate.scheme === Scheme.CORE && now < refundDeadlineOf(item, w)) {
    return 'refundable'
  }
  return 'history'
}

export type StatusView = { text: string; tone: 'neutral' | 'ink' | 'lime' | 'limetext' | 'danger' | 'quiet' }

/** The chip for a debit: Announced · Refundable · Paid · Refunded · MD06 · Returned · AM04 · Refused · MS02 ... */
export function statusOf(item: DebitItem, now: number, w: Windows): StatusView {
  const c = item.collection
  const code = decodeReturnCode(c.code)
  switch (c.status) {
    case CollectionStatus.SCHEDULED:
      return { text: 'Announced', tone: 'neutral' }
    case CollectionStatus.SETTLED:
      return bucketOf(item, now, w) === 'refundable' ? { text: 'Refundable', tone: 'lime' } : { text: 'Paid', tone: 'ink' }
    case CollectionStatus.FINAL:
      return { text: item.mandate.scheme === Scheme.B2B ? 'Paid · final' : 'Paid', tone: 'ink' }
    case CollectionStatus.REFUNDED:
      return { text: `Refunded · ${code || 'MD06'}`, tone: 'limetext' }
    case CollectionStatus.RETURNED:
      return { text: `Returned · ${code || 'MS03'}`, tone: 'danger' }
    case CollectionStatus.REFUSED:
      return { text: `Refused · ${code || 'MS02'}`, tone: 'danger' }
    case CollectionStatus.EXPIRED:
      return { text: 'Expired', tone: 'quiet' }
    case CollectionStatus.CANCELLED:
      return { text: 'Cancelled', tone: 'quiet' }
    default:
      return { text: 'Unknown', tone: 'quiet' }
  }
}

export function mandateStatusView(m: MandateRecord, lapsed: boolean): StatusView {
  if (m.status === MandateStatus.REVOKED) return { text: 'Revoked · MD01', tone: 'danger' }
  if (m.status === MandateStatus.USED) return { text: 'Used', tone: 'quiet' }
  if (m.status === MandateStatus.ACTIVE && lapsed) return { text: 'Lapsed · MD01', tone: 'danger' }
  if (m.status === MandateStatus.ACTIVE) return { text: 'Active', tone: 'lime' }
  return { text: 'None', tone: 'quiet' }
}

/** The moment a debit is "about": when it was taken, or is due. */
export function momentOf(item: DebitItem): number {
  const c = item.collection
  return Number(c.settledAt) > 0 ? Number(c.settledAt) : Number(c.dueAt)
}

import { formatUnits, type Address, type Hex } from 'viem'
import { e2eIdText, TOKEN_DECIMALS } from '@recall/sdk'
import { formatUnitsExact } from '@/onchain-money'

export type TokenSymbol = 'EURC' | 'USDC'

export const CURRENCY_SIGN: Record<TokenSymbol, string> = { EURC: '€', USDC: '$' }

/** "12.00", "0.05", "0.000001": at least two fraction digits, never rounded, never more than the token has. */
export function formatAmountPlain(raw: bigint): string {
  const exact = formatUnitsExact(raw, TOKEN_DECIMALS)
  const [whole = '0', frac = ''] = exact.split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.padEnd(2, '0')}`
}

export function formatToken(raw: bigint, symbol: TokenSymbol): string {
  return `${CURRENCY_SIGN[symbol]}${formatAmountPlain(raw)}`
}

/** For figures in a mono column: "12.00 EURC". */
export function formatTokenMono(raw: bigint, symbol: TokenSymbol): string {
  return `${formatAmountPlain(raw)} ${symbol}`
}

/** Plain number for inputs. */
export function formatInput(raw: bigint): string {
  return formatUnitsExact(raw, TOKEN_DECIMALS)
}

export function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

const dayMonth = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' })
const dayMonthTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
const fullDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
const fullDateTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
const clockTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const ms = (unix: bigint | number) => Number(unix) * 1000

export const fmtDay = (unix: bigint | number) => dayMonth.format(ms(unix))
export const fmtDayTime = (unix: bigint | number) => dayMonthTime.format(ms(unix)).replace(',', ',')
export const fmtDate = (unix: bigint | number) => fullDate.format(ms(unix))
export const fmtDateTime = (unix: bigint | number) => fullDateTime.format(ms(unix))
export const fmtClock = (unix: bigint | number) => clockTime.format(ms(unix))

export interface CountdownParts {
  d: number
  h: number
  m: number
  s: number
}

export function countdownParts(totalSeconds: number): CountdownParts {
  const t = Math.max(0, Math.floor(totalSeconds))
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "7d 23h 41m 05s". Short windows drop the leading zero units: "04m 12s". */
export function countdownText(totalSeconds: number): string {
  const { d, h, m, s } = countdownParts(totalSeconds)
  if (d > 0) return `${d}d ${h}h ${pad(m)}m ${pad(s)}s`
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`
  return `${pad(m)}m ${pad(s)}s`
}

/** Human duration for limits: "30 days", "2 minutes". */
export function durationText(seconds: number): string {
  if (seconds % 86400 === 0 && seconds >= 86400) {
    const d = seconds / 86400
    return `${d} day${d === 1 ? '' : 's'}`
  }
  if (seconds % 3600 === 0 && seconds >= 3600) {
    const h = seconds / 3600
    return `${h} hour${h === 1 ? '' : 's'}`
  }
  if (seconds % 60 === 0 && seconds >= 60) {
    const m = seconds / 60
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

/** A bytes32 reference shown as text when it is printable (e.g. "NW-PROD-2026-11-001"), else shortened hex. */
export function refText(ref: Hex): string {
  const t = e2eIdText(ref)
  return t.startsWith('0x') ? shortHash(t) : t
}

/** Mandate reference as shown to people: offerRef plus a short suffix of the payer address. */
export function mandateReference(offerRef: Hex, debtor: Address): string {
  return `${refText(offerRef)} · …${debtor.slice(-4).toLowerCase()}`
}

export function rawToNumber(raw: bigint): number {
  return Number(formatUnits(raw, TOKEN_DECIMALS))
}

/** A moment on a window bar: the day on prod, the clock time on the demo rail where the whole window lasts minutes. */
export function fmtMoment(unix: bigint | number, demo: boolean): string {
  return demo ? fmtClock(unix) : fmtDay(unix)
}

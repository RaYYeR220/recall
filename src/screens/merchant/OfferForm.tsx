import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { getAddress, isAddress } from 'viem'
import {
  encodeCheckoutToken,
  mandateTextForOffer,
  refToBytes32,
  Scheme,
  termsHash,
  tokenBySymbol,
  TIME_SCALE,
  validateOffer,
  verifyCheckoutLink,
  ZERO_ADDRESS,
  type CheckoutLinkPayload,
  type MandateOffer,
} from '@recall/sdk'
import { Chip, DemoPill, Button } from '@/components/ui'
import { useRail } from '@/hooks/useWallet'
import { isUserRejection } from '@/lib/actions'
import { getPublicClient } from '@/lib/clients'
import { notify } from '@/lib/notify'
import { useNetwork } from '@/lib/network'
import { parseUsdc } from '@/onchain-money'
import type { TokenSymbol } from '@/lib/format'
import { useMerchantCtx } from './ctx'

const DAY = 86_400
const inDays = (n: number) => new Date(Date.now() + n * DAY * 1000).toISOString().slice(0, 10)

function amount(v: string): bigint | null {
  try {
    const n = parseUsdc(v.trim())
    return n > 0n ? n : null
  } catch {
    return null
  }
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-[12.5px] text-ink-3">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1 block text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  )
}

export interface CreatedOffer {
  payload: CheckoutLinkPayload
  token: string
}

/** The offer form. It previews the exact mandate text from the SDK and signs the offer (EIP-712) into a checkout link. */
export function OfferForm({ onCreated }: { onCreated: (o: CreatedOffer) => void }) {
  const { network } = useNetwork()
  const { instance, creditor, gate } = useMerchantCtx()
  const rail = useRail(instance)
  const demo = instance === 'demo'

  const [symbol, setSymbol] = useState<TokenSymbol>('EURC')
  const [scheme, setScheme] = useState<number>(Scheme.CORE)
  const [oneOff, setOneOff] = useState(false)
  const [cap, setCap] = useState(demo ? '0.50' : '25.00')
  const [periodCap, setPeriodCap] = useState(demo ? '1.00' : '50.00')
  const [periodDays, setPeriodDays] = useState('30')
  const [noticeDays, setNoticeDays] = useState('14')
  const [ref, setRef] = useState('')
  const [maxUses, setMaxUses] = useState('0')
  const [validDate, setValidDate] = useState(() => inDays(30))
  const [today] = useState(() => inDays(0))
  const [mountedAt] = useState(() => Math.floor(Date.now() / 1000))
  const [debtor, setDebtor] = useState('')
  const [busy, setBusy] = useState(false)

  const draft = useMemo(() => {
    const errors: string[] = []
    const c = amount(cap)
    const p = amount(periodCap)
    if (c === null) errors.push('Enter a cap per debit.')
    if (p === null) errors.push('Enter a cap per period.')
    const period = Number(periodDays)
    const notice = Number(noticeDays)
    if (!Number.isInteger(period) || period < 1) errors.push('The period is a whole number of days.')
    if (!Number.isInteger(notice) || notice < 1) errors.push('The notice is a whole number of days.')
    const uses = Number(maxUses)
    if (!Number.isInteger(uses) || uses < 0) errors.push('Max uses is 0 (unlimited) or a whole number.')
    if (ref.trim() === '') errors.push('Give the offer a reference.')
    const until = Math.floor(new Date(`${validDate}T23:59:59Z`).getTime() / 1000)
    if (!Number.isFinite(until)) errors.push('Pick a valid-until date.')
    const bound = debtor.trim()
    if (bound !== '' && !isAddress(bound)) errors.push('The bound payer is not an address.')
    if (errors.length > 0 || c === null || p === null) return { errors, offer: undefined, text: undefined }
    const offer: MandateOffer = {
      creditorId: creditor.id,
      token: tokenBySymbol(network, symbol).address,
      scheme,
      oneOff,
      maxPerCollection: c,
      maxPerPeriod: p,
      periodLength: period * DAY,
      prenoticeLength: notice * DAY,
      offerRef: refToBytes32(ref.trim()),
      termsHash: `0x${'00'.repeat(32)}`,
      maxUses: uses,
      validUntil: BigInt(until),
      timeScale: TIME_SCALE[instance],
      debtor: bound === '' ? ZERO_ADDRESS : getAddress(bound),
    }
    const problems = validateOffer(offer, instance, mountedAt)
    const text = mandateTextForOffer(offer, { creditorName: creditor.name, network, instance, rail: rail.rail, token: symbol })
    return { errors: problems, offer, text }
  }, [cap, periodCap, periodDays, noticeDays, ref, maxUses, validDate, debtor, symbol, scheme, oneOff, creditor, network, instance, rail.rail, mountedAt])

  async function create() {
    if (!draft.offer || !draft.text || draft.errors.length > 0) return
    setBusy(true)
    try {
      const offer: MandateOffer = { ...draft.offer, termsHash: termsHash(draft.text) }
      const offerSig = await rail.signOffer(offer)
      const payload: CheckoutLinkPayload = { network, instance, offer, offerSig, creditorName: creditor.name, terms: draft.text }
      // Verify the way a payer's browser will, so a broken offer is caught here and not in front of a customer.
      const v = await verifyCheckoutLink(getPublicClient(network), rail.rail, payload)
      if (!v.valid) {
        notify.info({ title: 'The rail would not accept this offer', detail: v.problems.map((p) => p.message).join(' '), duration: 12_000 })
        return
      }
      onCreated({ payload, token: encodeCheckoutToken(payload) })
      notify.success({ title: 'Checkout link created', detail: 'The offer is signed. Share the link or the QR code.' })
    } catch (e) {
      if (isUserRejection(e)) notify.info({ title: 'Cancelled', detail: 'Nothing was signed.' })
      else notify.info({ title: 'Could not create the link', detail: e instanceof Error ? e.message.split('\n')[0] : 'Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.05fr]">
      <form
        className="panel space-y-5 p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
        aria-label="New mandate offer"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[17px] font-medium tracking-tight">New offer</h3>
          {demo && <DemoPill />}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          <Field label="Token">
            <Seg label="Token" value={symbol} onChange={setSymbol} options={[{ v: 'EURC', label: 'EURC' }, { v: 'USDC', label: 'USDC' }]} />
          </Field>
          <Field label="Scheme" hint={scheme === Scheme.CORE ? '8-week refund right' : 'No refund right: business payers only'}>
            <Seg label="Scheme" value={scheme} onChange={setScheme} options={[{ v: Scheme.CORE, label: 'Core' }, { v: Scheme.B2B, label: 'B2B' }]} />
          </Field>
        </div>
        <label className="flex items-center gap-2.5 text-[13.5px]">
          <input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} className="h-4 w-4 accent-[#c8f04f]" />
          One debit only
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Most per debit" hint={demo ? 'Demo rail: at most 1.00' : undefined}>
            <input className="field" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <Field label="Most per period" hint={demo ? 'Demo rail: at most 2.00' : undefined}>
            <input className="field" inputMode="decimal" value={periodCap} onChange={(e) => setPeriodCap(e.target.value)} />
          </Field>
          <Field label="Period (days)">
            <input className="field" inputMode="numeric" value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} />
          </Field>
          <Field label="Notice before each debit (days)" hint={demo ? 'Legal days. They run 10,080 times faster here.' : 'At least 1 day'}>
            <input className="field" inputMode="numeric" value={noticeDays} onChange={(e) => setNoticeDays(e.target.value)} />
          </Field>
          <Field label="Reference">
            <input className="field !font-sans" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="GYM-2026" maxLength={31} />
          </Field>
          <Field label="Max uses" hint="0 = unlimited">
            <input className="field" inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </Field>
          <Field label="Valid until">
            <input className="field" type="date" value={validDate} min={today} onChange={(e) => setValidDate(e.target.value)} />
          </Field>
          <Field label="Only this payer (optional)">
            <input className="field" value={debtor} onChange={(e) => setDebtor(e.target.value)} placeholder="0x… or leave open" spellCheck={false} />
          </Field>
        </div>
        {draft.errors.length > 0 && (
          <ul className="space-y-1 text-[12.5px] text-danger" role="alert">
            {draft.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || draft.errors.length > 0 || !!gate} title={gate}>
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Signing…
              </span>
            ) : (
              'Create checkout link'
            )}
          </Button>
          {gate && <span className="text-[12.5px] text-ink-3">{gate}</span>}
        </div>
      </form>

      <section className="panel p-5 sm:p-6" aria-labelledby="preview-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="preview-title" className="text-[17px] font-medium tracking-tight">
            What the payer will read
          </h3>
          <Chip tone="quiet" dot={false} mono>
            written by the SDK from the fields
          </Chip>
        </div>
        {draft.text ? (
          <div className="inner mt-4 max-h-[34rem] overflow-auto whitespace-pre-wrap p-4 text-[13.5px] leading-relaxed text-ink-2" tabIndex={0} role="region" aria-label="Mandate text preview">
            {draft.text}
          </div>
        ) : (
          <p className="mt-4 text-[13.5px] text-ink-3">Fill in the form to see the exact text.</p>
        )}
        <p className="mt-3 text-[12px] leading-snug text-ink-3">
          The text is generated from the offer&rsquo;s own fields and your registered name, then hashed into the offer you sign. The payer&rsquo;s
          browser rebuilds it and refuses anything that differs.
        </p>
      </section>
    </div>
  )
}


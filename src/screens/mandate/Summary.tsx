import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { addressUrl, Scheme, ZERO_ADDRESS, type CheckoutLinkPayload, type TokenInfo } from '@recall/sdk'
import { Chip, DemoPill, ExtLink } from '@/components/ui'
import type { OfferCheck } from '@/hooks/useOfferCheck'
import { durationText, fmtDate, formatToken, refText, shortAddress, shortHash } from '@/lib/format'

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="inner px-4 py-3.5">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mono mt-1.5 text-[15px] leading-snug text-ink">{value}</dd>
      {note && <div className="mt-1 text-[12px] leading-snug text-ink-3">{note}</div>}
    </div>
  )
}

export function Summary({
  payload,
  check,
  token,
  creditorName,
}: {
  payload: CheckoutLinkPayload
  check: OfferCheck
  token: TokenInfo
  creditorName: string
}) {
  const { offer, instance, network } = payload
  const isCore = offer.scheme === Scheme.CORE
  const demo = instance === 'demo'
  const scale = offer.timeScale
  const named = offer.debtor !== ZERO_ADDRESS
  const scaled = (legal: number) => (demo ? `${durationText(Math.max(1, Math.floor(legal / scale)))} on this rail` : undefined)
  const refundWindow = Number(check.windows.refundWindow)
  const linkName = payload.creditorName.trim()

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow mr-1">Mandate offer</span>
        <Chip tone={isCore ? 'lime' : 'quiet'}>{isCore ? 'Core · refund right' : 'B2B · no refund right'}</Chip>
        {demo && <DemoPill />}
        <Chip tone="ink" dot={false}>
          <Check size={12} aria-hidden="true" />
          Signature verified{check.signature.role ? ` · ${check.signature.role}` : ''}
        </Chip>
      </div>

      <h1 className="mt-5 text-[clamp(30px,4.4vw,48px)] font-medium leading-[1.04] tracking-[-0.045em] text-balance">
        {creditorName} asks to debit your {token.symbol}.
      </h1>
      <p className="lede mt-3 max-w-xl">
        Read what you are agreeing to. Nothing moves until you sign, and every debit is announced to you first.
        {isCore
          ? ' For eight weeks after any debit you can take it back.'
          : ' This is a business mandate: debits are final once they settle.'}
      </p>
      {linkName && linkName !== creditorName && (
        <p className="mt-3 rounded-panel border border-danger/30 px-3.5 py-2.5 text-[12.5px] leading-snug text-ink-2" role="note">
          The link calls this creditor <span className="mono text-danger">{linkName}</span>, but the contract has creditor #
          {offer.creditorId.toString()} registered as <span className="mono text-ink">{creditorName}</span>. Go by the contract.
        </p>
      )}

      <dl className="mt-8 grid gap-3 sm:grid-cols-2">
        <Fact label="Token" value={token.symbol} note={<ExtLink href={addressUrl(network, token.address)}>{shortAddress(token.address)}</ExtLink>} />
        <Fact label="Most per debit" value={formatToken(offer.maxPerCollection, token.symbol)} />
        <Fact
          label="Most per period"
          value={formatToken(offer.maxPerPeriod, token.symbol)}
          note={
            <>
              every {durationText(offer.periodLength)}
              {scaled(offer.periodLength) && <span className="text-accent"> · {scaled(offer.periodLength)}</span>}
            </>
          }
        />
        <Fact
          label="Notice before each debit"
          value={durationText(offer.prenoticeLength)}
          note={
            <>
              at least, and never under {durationText(Number(check.windows.minPrenotice))}
              {scaled(offer.prenoticeLength) && <span className="text-accent"> · {scaled(offer.prenoticeLength)}</span>}
            </>
          }
        />
        <Fact
          label="Refund right"
          value={isCore ? durationText(refundWindow) : 'None'}
          note={isCore ? 'Full refund of any debit, no questions asked' : 'B2B debits are final at once'}
        />
        <Fact
          label="How often"
          value={offer.oneOff ? 'One debit only' : 'Repeating'}
          note={offer.maxUses > 0 ? `This offer can be accepted ${offer.maxUses} time${offer.maxUses === 1 ? '' : 's'}` : undefined}
        />
        <Fact
          label="Offer valid until"
          value={offer.validUntil > 0n ? fmtDate(offer.validUntil) : 'No expiry'}
        />
        <Fact label="Reference" value={refText(offer.offerRef)} note={`Creditor #${offer.creditorId.toString()}`} />
      </dl>

      {named && (
        <p className="mt-4 text-[13px] text-ink-3">
          This offer is for one wallet only: <span className="mono text-ink-2">{shortAddress(offer.debtor)}</span>.
        </p>
      )}

      <section className="mt-8" aria-labelledby="terms-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="terms-title" className="text-[15px] font-medium tracking-tight">
            The mandate text
          </h2>
          <span className="mono text-[11.5px] text-ink-3" title={offer.termsHash}>
            fingerprint {shortHash(offer.termsHash)} · matches what was signed
          </span>
        </div>
        <div
          className="inner mt-3 max-h-80 overflow-auto p-4 text-[14px] leading-relaxed text-ink-2 whitespace-pre-wrap text-pretty"
          tabIndex={0}
          role="region"
          aria-label="Full mandate text"
        >
          {payload.terms}
        </div>
      </section>

      <p className="mt-6 text-[12.5px] leading-relaxed text-ink-3">
        This rail is an immutable contract with no owner.{' '}
        <Link className="text-ink-2 underline underline-offset-4 hover:text-ink" to="/#sepa">
          How the rules compare to SEPA
        </Link>
        .
      </p>
    </div>
  )
}

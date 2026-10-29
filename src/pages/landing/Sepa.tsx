import { ArrowRight } from 'lucide-react'
import { Reveal } from '@/components/Reveal'

const ROWS: { name: string; sepa: string; recall: string; code?: string }[] = [
  {
    name: 'Mandate',
    sepa: 'A signed mandate with a unique reference.',
    recall: 'The merchant signs an offer, you sign the acceptance. Anyone can submit both, so you never need gas.',
  },
  {
    name: 'Pre-notification',
    sepa: 'Notice before every debit: 14 days unless agreed.',
    recall: 'A debit can only be scheduled at least the mandate\u2019s notice ahead, and never under one day.',
  },
  {
    name: '8-week refund',
    sepa: 'Full refund within 8 weeks, no questions asked.',
    recall: 'One click, paid back at once from the merchant\u2019s reserve or the funds the contract holds.',
    code: 'MD06',
  },
  {
    name: 'Refusal',
    sepa: 'Refuse a debit before it runs.',
    recall: 'Refuse any announced debit. It never runs.',
    code: 'MS02',
  },
  {
    name: 'Lapse',
    sepa: 'A mandate lapses after 36 months without a debit.',
    recall: 'After that, collections are refused by the contract.',
    code: 'MD01',
  },
  {
    name: 'B2B',
    sepa: 'The business scheme has no refund right.',
    recall: 'Scheme B2B: final at once, nothing locked and nothing held.',
  },
]

export function Sepa() {
  return (
    <section id="sepa" className="mx-auto w-full max-w-app scroll-mt-20 px-4 pt-24 sm:px-8 sm:pt-32" aria-labelledby="sepa-title">
      <Reveal>
        <div className="eyebrow">Same rules as SEPA</div>
        <h2 id="sepa-title" className="section-title mt-3 max-w-2xl">
          The bank rulebook, enforced by a contract.
        </h2>
        <p className="lede mt-4 max-w-xl">
          Europe protects the payer with rules, not with the merchant&rsquo;s goodwill. Recall carries the same rules to EURC and
          USDC.
        </p>
      </Reveal>

      <Reveal className="panel mt-10 overflow-hidden">
        <div className="hidden grid-cols-[1fr_28px_1.2fr] gap-6 border-b border-line px-6 py-3.5 md:grid">
          <span className="eyebrow">SEPA Core rule</span>
          <span aria-hidden="true" />
          <span className="eyebrow">Recall, enforced by contract</span>
        </div>
        <dl>
          {ROWS.map((r) => (
            <div
              key={r.name}
              className="grid gap-x-6 gap-y-2 border-b border-line px-5 py-5 last:border-b-0 md:grid-cols-[1fr_28px_1.2fr] md:items-baseline md:px-6"
            >
              <dt>
                <div className="text-[15px] font-medium tracking-tight">{r.name}</div>
                <div className="mt-1 text-[13.5px] leading-relaxed text-ink-3 text-pretty">{r.sepa}</div>
              </dt>
              <span className="hidden self-center text-ink-3 md:block" aria-hidden="true">
                <ArrowRight size={16} />
              </span>
              <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                <span className="max-w-md text-[14px] leading-relaxed text-ink-2 text-pretty">{r.recall}</span>
                {r.code && <span className="chip chip-mono chip-quiet">{r.code}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>
      <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
        Not implemented on purpose: SEPA&rsquo;s 13-month claim for unauthorised debits. Every collection needs your signature,
        verified onchain, so an unauthorised one cannot exist.
      </p>
    </section>
  )
}

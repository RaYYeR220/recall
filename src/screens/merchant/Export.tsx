import { Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toCamt054, toCsv, type StatementEntry } from '@recall/sdk'
import { Chip } from '@/components/ui'
import { buildStatement } from '@/lib/statement'
import { notify } from '@/lib/notify'
import { useNetwork } from '@/lib/network'
import { useRail } from '@/hooks/useWallet'
import { useMerchantCtx } from './ctx'

function download(name: string, mime: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** camt.054 (ISO 20022) and CSV of settled, refunded and returned collections, built from the chain. */
export function Export() {
  const { network } = useNetwork()
  const { instance, creditor } = useMerchantCtx()
  const rail = useRail(instance)
  const [entries, setEntries] = useState<StatementEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function build() {
    setBusy(true)
    setEntries(null)
    try {
      const e = await buildStatement({ network, instance, creditorId: creditor.id, creditorName: creditor.name, payout: creditor.payout }, setMsg)
      setEntries(e)
      if (e.length === 0) notify.info({ title: 'Nothing to export yet', detail: 'No debit has settled, been refunded or been returned.' })
    } catch {
      notify.info({ title: 'Could not build the statement', detail: 'The chain did not answer. Try again.' })
    } finally {
      setBusy(false)
      setMsg('')
    }
  }

  const fileBase = () => `recall-${instance}-${creditor.id}-${new Date().toISOString().slice(0, 10)}`
  const count = (k: StatementEntry['kind']) => entries?.filter((x) => x.kind === k).length ?? 0

  function xml() {
    if (!entries) return
    download(`${fileBase()}.camt054.xml`, 'application/xml', toCamt054(entries, { network, instance, rail: rail.rail, account: creditor.payout, accountName: creditor.name, perspective: 'creditor' }))
  }

  return (
    <section className="panel p-5 sm:p-6" aria-labelledby="export-title">
      <h2 id="export-title" className="text-[20px] font-medium tracking-[-0.03em]">
        Export
      </h2>
      <p className="mt-1.5 max-w-xl text-[13.5px] leading-snug text-ink-3">
        An ISO 20022 camt.054 notification for your accounting system, or a CSV. Every line carries its transaction hash.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-light btn-sm" disabled={busy} onClick={() => void build()}>
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {msg || 'Working…'}
            </span>
          ) : (
            'Build statement'
          )}
        </button>
        {entries && entries.length > 0 && (
          <>
            <button type="button" className="btn btn-line btn-sm" onClick={xml}>
              <Download size={14} className="mr-2" aria-hidden="true" />
              camt.054 XML
            </button>
            <button type="button" className="btn btn-line btn-sm" onClick={() => download(`${fileBase()}.csv`, 'text/csv', toCsv(entries, { perspective: 'creditor' }))}>
              <Download size={14} className="mr-2" aria-hidden="true" />
              CSV
            </button>
          </>
        )}
      </div>
      {entries && entries.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" role="status">
          <Chip tone="ink" mono>{count('collection')} collected</Chip>
          <Chip tone="limetext" mono>{count('refund')} refunded</Chip>
          <Chip tone="danger" mono>{count('return')} returned</Chip>
        </div>
      )}
    </section>
  )
}

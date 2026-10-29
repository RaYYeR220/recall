import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { isAddress } from 'viem'
import { Button } from '@/components/ui'
import { useRail, useWallet } from '@/hooks/useWallet'
import { runTx } from '@/lib/actions'
import { useNetwork } from '@/lib/network'
import type { RailInstance } from '@recall/sdk'

/** Register the connected wallet as a creditor: a name that payers will see, and where the money is paid out. */
export function Register({ instance, gate }: { instance: RailInstance; gate: string | undefined }) {
  const { network } = useNetwork()
  const { address } = useWallet()
  const rail = useRail(instance)
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [payout, setPayout] = useState('')
  const [busy, setBusy] = useState(false)

  const payoutAddr = (payout.trim() || address)
  const nameOk = name.trim().length >= 2 && name.trim().length <= 64
  const payoutOk = !!payoutAddr && isAddress(payoutAddr)

  async function submit() {
    if (!payoutOk || !nameOk) return
    setBusy(true)
    const res = await runTx({
      network,
      pendingTitle: 'Register creditor',
      title: 'Creditor registered',
      successDetail: 'Fund a reserve next, then create your first checkout link.',
      send: () => rail.registerCreditor(name.trim(), payoutAddr),
    })
    setBusy(false)
    if (res.ok) await qc.invalidateQueries({ queryKey: ['creditors'] })
  }

  return (
    <section className="panel mx-auto max-w-xl p-6 sm:p-8" aria-labelledby="reg-title">
      <div className="eyebrow">Step one</div>
      <h2 id="reg-title" className="section-title mt-3">
        Register as a creditor.
      </h2>
      <p className="lede mt-2">
        Payers see this name on every mandate and debit. It is stored on the {instance} rail and anyone can read it, so it cannot be
        faked in a link.
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="block">
          <span className="text-[12.5px] text-ink-3">Name</span>
          <input className="field mt-1.5 !font-sans" value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind Gym" maxLength={64} autoComplete="organization" />
        </label>
        <label className="block">
          <span className="text-[12.5px] text-ink-3">Payout address</span>
          <input className="field mt-1.5" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder={address ?? '0x…'} spellCheck={false} autoComplete="off" />
          <span className="mt-1.5 block text-[12px] text-ink-3">Where settled debits are paid. Defaults to this wallet.</span>
        </label>
        <Button type="submit" size="sm" disabled={busy || !nameOk || !payoutOk || !!gate} title={gate}>
          {busy ? 'Working…' : 'Register creditor'}
        </Button>
        {gate && <p className="text-[12.5px] text-ink-3">{gate}</p>}
      </form>
    </section>
  )
}

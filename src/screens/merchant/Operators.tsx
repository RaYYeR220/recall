import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { Skeleton } from '@/components/ui'
import { useOperators } from '@/hooks/useMerchant'
import { useRail } from '@/hooks/useWallet'
import { runTx } from '@/lib/actions'
import { shortAddress } from '@/lib/format'
import { useNetwork } from '@/lib/network'
import { useMerchantCtx } from './ctx'

/** Operators may sign offers, pre-notify and cancel. They cannot touch the reserve or the payout address. */
export function Operators() {
  const { network } = useNetwork()
  const { instance, creditor, isOwner, gate } = useMerchantCtx()
  const rail = useRail(instance)
  const qc = useQueryClient()
  const ops = useOperators(network, instance, creditor.id)
  const [addr, setAddr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  async function set(op: string, allowed: boolean) {
    setBusy(op)
    const res = await runTx({
      network,
      pendingTitle: allowed ? 'Add operator' : 'Remove operator',
      title: allowed ? 'Operator added' : 'Operator removed',
      successDetail: allowed ? 'They can now sign offers and pre-notify for this creditor.' : 'They can no longer act for this creditor.',
      send: () => rail.setOperator(creditor.id, getAddress(op), allowed),
    })
    setBusy(null)
    if (res.ok) {
      setAddr('')
      await qc.invalidateQueries({ queryKey: ['operators'] })
    }
  }

  const valid = isAddress(addr.trim())
  return (
    <section className="panel p-5 sm:p-6" aria-labelledby="ops-title">
      <h2 id="ops-title" className="text-[20px] font-medium tracking-[-0.03em]">
        Operators
      </h2>
      <p className="mt-1.5 max-w-xl text-[13.5px] leading-snug text-ink-3">
        Wallets that can sign offers, pre-notify and cancel debits for {creditor.name}. They can never withdraw the reserve or change the payout.
      </p>
      <div className="mt-4">
        {ops.isLoading && <Skeleton className="h-12" />}
        {ops.data && ops.data.length === 0 && <p className="text-[13px] text-ink-3">No operators. Only the owner can act.</p>}
        {ops.data && ops.data.length > 0 && (
          <ul className="divide-y divide-line">
            {ops.data.map((o) => (
              <li key={o} className="flex items-center gap-3 py-2.5">
                <span className="mono text-[13px] text-ink">
                  <span className="sm:hidden">{shortAddress(o)}</span>
                  <span className="hidden sm:inline">{o}</span>
                </span>
                {isOwner && (
                  <button type="button" className="btn btn-line btn-xs ml-auto" disabled={busy !== null || !!gate} title={gate} onClick={() => void set(o, false)}>
                    {busy === o ? 'Working…' : 'Remove'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {isOwner ? (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) void set(addr.trim(), true)
          }}
        >
          <input className="field" placeholder="0x… operator wallet" value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} aria-label="Operator address" />
          <button type="submit" className="btn btn-light btn-xs flex-none" disabled={!valid || busy !== null || !!gate} title={gate}>
            Add
          </button>
        </form>
      ) : (
        <p className="mt-4 text-[12.5px] text-ink-3">Only the owner can add or remove operators.</p>
      )}
    </section>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import {
  debitRailAbi,
  decodeRailError,
  networkInfo,
  RelayError,
  type ActionKindName,
  type RailError,
  type RailInstance,
} from '@recall/sdk'
import { useRail, useWallet } from '@/hooks/useWallet'
import { isUserRejection, runTx } from '@/lib/actions'
import { getPublicClient } from '@/lib/clients'
import type { TokenSymbol } from '@/lib/format'
import { notify } from '@/lib/notify'
import { useNetwork } from '@/lib/network'

export type Path = 'sign' | 'self'
type Fn = 'refund' | 'refuse' | 'revoke'

interface Spec {
  key: string
  fn: Fn
  kind: ActionKindName
  target: Hex
  /** Present-tense name for pending and refusal toasts: "Refund". */
  pending: string
  /** Past tense for success: "Refunded". */
  done: string
  detail: string
  code: string
}

/** Refund, refuse, revoke and lower-the-allowance, each by signature (a relay pays gas) or sent by the wallet itself. */
export function usePayerActions(instance: RailInstance, viewAs: Address | undefined) {
  const { network } = useNetwork()
  const rail = useRail(instance)
  const w = useWallet()
  const qc = useQueryClient()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const isYou = !!w.address && (!viewAs || viewAs.toLowerCase() === w.address.toLowerCase())
  let blocked: string | undefined
  if (!w.isConnected) blocked = 'Connect your wallet first.'
  else if (!isYou) blocked = 'You are watching another address. Connect as that address to act.'

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['debtor'] }),
      qc.invalidateQueries({ queryKey: ['full-history'] }),
      qc.invalidateQueries({ queryKey: ['wallet-figures'] }),
      qc.invalidateQueries({ queryKey: ['lapsed'] }),
    ])
  }

  async function precheck(fn: Fn, target: Hex, account: Address): Promise<RailError | null> {
    const data =
      fn === 'refund'
        ? encodeFunctionData({ abi: debitRailAbi, functionName: 'refund', args: [target] })
        : fn === 'refuse'
          ? encodeFunctionData({ abi: debitRailAbi, functionName: 'refuse', args: [target] })
          : encodeFunctionData({ abi: debitRailAbi, functionName: 'revoke', args: [target] })
    try {
      await getPublicClient(network).call({ account, to: rail.rail, data })
      return null
    } catch (e) {
      const err = decodeRailError(e)
      return err.name === 'UnknownError' ? null : err
    }
  }

  async function act(spec: Spec, path: Path) {
    if (blocked || !w.address) {
      notify.info({ title: 'Not yet', detail: blocked })
      return
    }
    const account = w.address
    setBusyKey(spec.key)
    try {
      await w.ensureChain()
      // Ask the contract first, as the payer. If it would refuse, say so before anyone is asked to sign.
      const refusal = await precheck(spec.fn, spec.target, account)
      if (refusal) {
        notify.refusal({ title: `${spec.pending} was refused`, error: refusal, network })
        return
      }
      const base = { network, title: spec.done, pendingTitle: spec.pending, successDetail: spec.detail, code: spec.code }

      if (path === 'self') {
        const send = () =>
          spec.fn === 'refund' ? rail.refund(spec.target) : spec.fn === 'refuse' ? rail.refuse(spec.target) : rail.revoke(spec.target)
        await runTx({ ...base, send })
      } else {
        const signed = await rail.signDebtorAction(spec.kind, spec.target)
        await runTx({
          ...base,
          send: () => rail.relayDebtorAction(signed.action, signed.debtor, signed.sig),
          onError: (e) => {
            if (!(e instanceof RelayError)) return false
            notify.info({
              title: "The gasless relay isn't available",
              detail: `${e.message} Your signature is kept, so you can submit it yourself.`,
              duration: 30_000,
              action: (
                <button
                  type="button"
                  className="btn btn-line btn-xs"
                  onClick={() => {
                    void runTx({ ...base, send: () => rail.executeDebtorAction(signed.action, signed.debtor, signed.sig) }).then(refresh)
                  }}
                >
                  Submit it myself
                </button>
              ),
            })
            return true
          },
        })
      }
      await refresh()
    } catch (e) {
      if (isUserRejection(e)) notify.info({ title: 'Cancelled', detail: 'Nothing was signed or sent.' })
      else notify.info({ title: `${spec.pending} failed`, detail: decodeRailError(e).message, duration: 10_000 })
    } finally {
      setBusyKey(null)
    }
  }

  const refund = (collectionId: Hex, path: Path) =>
    act(
      {
        key: `refund:${collectionId}`,
        fn: 'refund',
        kind: 'REFUND',
        target: collectionId,
        pending: 'Refund',
        done: 'Refunded',
        detail: 'Paid back from the merchant’s reserve and held funds.',
        code: 'MD06',
      },
      path,
    )
  const refuse = (collectionId: Hex, path: Path) =>
    act(
      {
        key: `refuse:${collectionId}`,
        fn: 'refuse',
        kind: 'REFUSE',
        target: collectionId,
        pending: 'Refuse',
        done: 'Refused',
        detail: 'This debit will not run.',
        code: 'MS02',
      },
      path,
    )
  const revoke = (mandateId: Hex, path: Path) =>
    act(
      {
        key: `revoke:${mandateId}`,
        fn: 'revoke',
        kind: 'REVOKE',
        target: mandateId,
        pending: 'Revoke',
        done: 'Revoked',
        detail: 'The merchant can no longer announce debits on this mandate.',
        code: 'MD01',
      },
      path,
    )

  /** Lower the rail's allowance on a token: an EIP-2612 permit to the lower value (relayed) or a plain approve. */
  async function reduceAllowance(symbol: TokenSymbol, value: bigint, path: Path) {
    if (blocked || !w.address) {
      notify.info({ title: 'Not yet', detail: blocked })
      return
    }
    const owner = w.address
    const info = networkInfo(network)
    const token = symbol === 'EURC' ? info.eurc.address : info.usdc.address
    const key = `allowance:${instance}:${symbol}`
    setBusyKey(key)
    try {
      await w.ensureChain()
      const base = {
        network,
        title: 'Allowance lowered',
        pendingTitle: 'Lower allowance',
        successDetail: `The ${instance} rail can now pull at most the new amount of ${symbol}.`,
      }
      if (path === 'self') {
        await runTx({ ...base, send: () => rail.setAllowance(token, value) })
      } else {
        const ts = (await getPublicClient(network).getBlock()).timestamp
        const permit = await rail.signPermit(token, value, ts + 3600n)
        await runTx({
          ...base,
          send: () => rail.relayPermit(token, owner, permit),
          onError: (e) => {
            if (!(e instanceof RelayError)) return false
            notify.info({
              title: "The gasless relay isn't available",
              detail: `${e.message} Your permit is kept, so you can submit it yourself.`,
              duration: 30_000,
              action: (
                <button
                  type="button"
                  className="btn btn-line btn-xs"
                  onClick={() => {
                    void runTx({ ...base, send: () => rail.submitPermit(token, owner, permit) }).then(refresh)
                  }}
                >
                  Submit it myself
                </button>
              ),
            })
            return true
          },
        })
      }
      await refresh()
    } catch (e) {
      if (isUserRejection(e)) notify.info({ title: 'Cancelled', detail: 'Nothing was signed or sent.' })
      else notify.info({ title: 'Lower allowance failed', detail: decodeRailError(e).message, duration: 10_000 })
    } finally {
      setBusyKey(null)
    }
  }

  return { busyKey, blocked, refund, refuse, revoke, reduceAllowance }
}

import type { Hex } from 'viem'
import { decodeRailError, RelayError, type RailError, type RailNetwork } from '@recall/sdk'
import { getPublicClient } from './clients'
import { notify } from './notify'

/** True when the person closed the wallet prompt: not an error, nothing to report as a failure. */
export function isUserRejection(e: unknown): boolean {
  let cur: unknown = e
  for (let i = 0; i < 8 && cur; i++) {
    const o = cur as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    if (o.code === 4001 || o.name === 'UserRejectedRequestError') return true
    if (typeof o.message === 'string' && /user (rejected|denied|cancel)/i.test(o.message)) return true
    cur = o.cause
  }
  return false
}

/** Replays a transaction that reverted onchain one block earlier, to recover the contract's own error. */
export async function replayRevert(network: RailNetwork, hash: Hex): Promise<RailError> {
  const client = getPublicClient(network)
  try {
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
    if (!tx.to) return decodeRailError(undefined)
    await client.call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      blockNumber: receipt.blockNumber > 0n ? receipt.blockNumber - 1n : receipt.blockNumber,
    })
    return { name: 'Reverted', code: null, message: 'The transaction reverted onchain.' }
  } catch (e) {
    return decodeRailError(e)
  }
}

export interface RunTxOptions {
  network: RailNetwork
  /** Past-tense result shown on success, e.g. "Refunded". */
  title: string
  /** Shown while the wallet or relay is working, e.g. "Refund". */
  pendingTitle: string
  successDetail?: string
  /** ISO 20022 code the action produces, shown in mono. */
  code?: string
  send: () => Promise<Hex>
  /** Return true if the failure was handled (for example by offering a fallback). */
  onError?: (e: unknown) => boolean
}

export interface RunTxResult {
  ok: boolean
  hash?: Hex
  error?: RailError
}

/** Sends, waits for the receipt, and tells the person exactly what the contract did, or refused to do. */
export async function runTx(opts: RunTxOptions): Promise<RunTxResult> {
  const { network } = opts
  const id = notify.pending(opts.pendingTitle, 'Waiting for the signature or submission…')
  let hash: Hex | undefined
  try {
    hash = await opts.send()
    notify.pending(opts.pendingTitle, 'Submitted. Waiting for the block…', network, hash, id)
    const receipt = await getPublicClient(network).waitForTransactionReceipt({ hash })
    if (receipt.status === 'reverted') {
      const error = await replayRevert(network, hash)
      notify.refusal({ id, title: `${opts.pendingTitle} was refused`, error, network, hash })
      return { ok: false, hash, error }
    }
    notify.success({ id, title: opts.title, detail: opts.successDetail, code: opts.code, network, hash })
    return { ok: true, hash }
  } catch (e) {
    notify.dismiss(id)
    if (isUserRejection(e)) {
      notify.info({ title: 'Cancelled', detail: 'Nothing was sent.' })
      return { ok: false }
    }
    if (opts.onError?.(e)) return { ok: false, hash }
    if (e instanceof RelayError) {
      notify.info({ title: 'The relay did not take it', detail: e.message })
      return { ok: false, hash }
    }
    const error = decodeRailError(e)
    if (error.name === 'UnknownError') {
      notify.info({ title: `${opts.pendingTitle} failed`, detail: error.message, duration: 10_000 })
    } else {
      notify.refusal({ title: `${opts.pendingTitle} was refused`, error, network, hash })
    }
    return { ok: false, hash, error }
  }
}

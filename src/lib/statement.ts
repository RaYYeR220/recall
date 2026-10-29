import { getAbiItem, type Address, type Hex } from 'viem'
import {
  CollectionStatus,
  collectionIdOf,
  debitRailAbi,
  decodeReturnCode,
  deploymentBlock,
  railAddresses,
  scanWindows,
  Scheme,
  tokenByAddress,
  type RailInstance,
  type RailNetwork,
  type StatementEntry,
} from '@recall/sdk'
import { readRail } from '@/hooks/useWallet'
import { getPublicClient } from '@/lib/clients'

const abiEvents = [
  getAbiItem({ abi: debitRailAbi, name: 'CollectionScheduled' }),
  getAbiItem({ abi: debitRailAbi, name: 'CollectionSettled' }),
  getAbiItem({ abi: debitRailAbi, name: 'CollectionRefunded' }),
  getAbiItem({ abi: debitRailAbi, name: 'CollectionReturned' }),
  getAbiItem({ abi: debitRailAbi, name: 'CollectionRefused' }),
] as const

export interface StatementSource {
  network: RailNetwork
  instance: RailInstance
  creditorId: bigint
  creditorName: string
  payout: Address
}

/**
 * Settled, refunded and returned collections of one creditor as statement entries, read only from the chain:
 * collections from RailLens, transaction hashes, block times and remittance text from the rail's events
 * (scanned in 9,000-block windows from the deployment block).
 */
export async function buildStatement(src: StatementSource, onProgress?: (msg: string) => void): Promise<StatementEntry[]> {
  const { network, instance } = src
  const rail = readRail(network, instance)
  const client = getPublicClient(network)

  onProgress?.('Reading mandates…')
  const { views } = await rail.creditorView(src.creditorId, 0, 0)
  const byId = new Map<string, { view: (typeof views)[number]; c: (typeof views)[number]['collections'][number] }>()
  for (const v of views) {
    const all = v.collectionCount > BigInt(v.collections.length) ? (await rail.collectionsPage(v.id, 0, 0)).page : v.collections
    for (const c of all) byId.set(collectionIdOf(v.id, c.e2eId).toLowerCase(), { view: v, c })
  }
  if (byId.size === 0) return []

  onProgress?.('Reading events…')
  const head = await client.getBlockNumber()
  const logs = await scanWindows(deploymentBlock(network), head, (from, to) =>
    client.getLogs({ address: railAddresses(network)[instance].rail, events: abiEvents, fromBlock: from, toBlock: to }),
  )
  const mine = logs.filter((l) => {
    const id = (l.args).collectionId
    return id !== undefined && byId.has(id.toLowerCase())
  })

  onProgress?.('Reading block times…')
  const blocks = [...new Set(mine.map((l) => l.blockNumber))]
  const times = new Map<bigint, number>()
  await Promise.all(
    blocks.map(async (n) => {
      times.set(n, Number((await client.getBlock({ blockNumber: n })).timestamp))
    }),
  )

  const remittance = new Map<string, string>()
  for (const l of mine) {
    if (l.eventName === 'CollectionScheduled') remittance.set((l.args.collectionId as Hex).toLowerCase(), l.args.remittanceInfo ?? '')
  }

  const entries: StatementEntry[] = []
  for (const l of mine) {
    if (l.eventName === 'CollectionScheduled') continue
    const id = (l.args.collectionId as Hex).toLowerCase()
    const hit = byId.get(id)
    if (!hit) continue
    const { view, c } = hit
    const token = tokenByAddress(network, view.mandate.token)?.symbol ?? 'EURC'
    const base = {
      token,
      amount: c.amount,
      collectionId: l.args.collectionId as Hex,
      mandateId: view.id,
      e2eId: c.e2eId,
      creditorId: src.creditorId,
      creditorName: src.creditorName,
      debtor: view.mandate.debtor,
      bookedAt: times.get(l.blockNumber) ?? 0,
      valueAt: c.dueAt,
      remittanceInfo: remittance.get(id),
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
      scheme: view.mandate.scheme === Scheme.CORE ? ('CORE' as const) : ('B2B' as const),
    }
    if (l.eventName === 'CollectionSettled' && c.status !== CollectionStatus.RETURNED) entries.push({ ...base, kind: 'collection' })
    else if (l.eventName === 'CollectionRefunded') entries.push({ ...base, kind: 'refund', returnCode: 'MD06' })
    else if (l.eventName === 'CollectionReturned') entries.push({ ...base, kind: 'return', returnCode: decodeReturnCode(l.args.code as Hex) || 'MS03' })
    else if (l.eventName === 'CollectionRefused') entries.push({ ...base, kind: 'return', returnCode: 'MS02' })
  }
  return entries.sort((a, b) => Number(a.bookedAt) - Number(b.bookedAt))
}

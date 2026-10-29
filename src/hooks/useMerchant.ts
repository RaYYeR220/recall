import { useQuery } from '@tanstack/react-query'
import { getAbiItem, type Address } from 'viem'
import {
  debitRailAbi,
  deploymentBlock,
  railAddresses,
  scanWindows,
  type RailInstance,
  type RailNetwork,
} from '@recall/sdk'
import { readRail } from '@/hooks/useWallet'
import { getPublicClient } from '@/lib/clients'

export interface CreditorRef {
  id: bigint
  name: string
  payout: Address
  owner: Address
  role: 'owner' | 'operator'
}

const registered = getAbiItem({ abi: debitRailAbi, name: 'CreditorRegistered' })
const operatorSet = getAbiItem({ abi: debitRailAbi, name: 'OperatorSet' })

/**
 * The creditors a wallet can act for on one rail: the ones it registered (CreditorRegistered, filtered by
 * owner) and the ones that made it an operator (OperatorSet, filtered by operator). The log scan is paginated
 * in 9,000-block windows from the rail's deployment block, never from block 0.
 */
export function useCreditors(network: RailNetwork, instance: RailInstance, wallet: Address | undefined) {
  return useQuery({
    enabled: !!wallet,
    queryKey: ['creditors', network, instance, wallet],
    queryFn: async (): Promise<CreditorRef[]> => {
      const client = getPublicClient(network)
      const address = railAddresses(network)[instance].rail
      const head = await client.getBlockNumber()
      const from = deploymentBlock(network)
      const [owned, opped] = await Promise.all([
        scanWindows(from, head, (f, t) => client.getLogs({ address, event: registered, args: { owner: wallet }, fromBlock: f, toBlock: t })),
        scanWindows(from, head, (f, t) => client.getLogs({ address, event: operatorSet, args: { operator: wallet }, fromBlock: f, toBlock: t })),
      ])
      const ids = new Set<bigint>()
      for (const l of owned) if (l.args.creditorId !== undefined) ids.add(l.args.creditorId)
      for (const l of opped) if (l.args.creditorId !== undefined && l.args.allowed) ids.add(l.args.creditorId)
      const out: CreditorRef[] = []
      for (const id of [...ids].sort((a, b) => (a < b ? -1 : 1))) {
        const c = await client.readContract({ address, abi: debitRailAbi, functionName: 'getCreditor', args: [id] })
        if (wallet && c.owner.toLowerCase() === wallet.toLowerCase()) {
          out.push({ id, name: c.name, payout: c.payout, owner: c.owner, role: 'owner' })
        } else if (wallet) {
          const isOp = await client.readContract({ address, abi: debitRailAbi, functionName: 'isOperator', args: [id, wallet] })
          if (isOp) out.push({ id, name: c.name, payout: c.payout, owner: c.owner, role: 'operator' })
        }
      }
      return out
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

export function useCoverage(network: RailNetwork, instance: RailInstance, creditorId: bigint | undefined) {
  return useQuery({
    enabled: creditorId !== undefined,
    queryKey: ['coverage', network, instance, creditorId?.toString()],
    queryFn: () => readRail(network, instance).coverage(creditorId as bigint),
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: 2,
  })
}

export function useCreditorMandates(network: RailNetwork, instance: RailInstance, creditorId: bigint | undefined, offset: number, limit: number) {
  return useQuery({
    enabled: creditorId !== undefined,
    queryKey: ['creditor-view', network, instance, creditorId?.toString(), offset, limit],
    queryFn: () => readRail(network, instance).creditorView(creditorId as bigint, offset, limit),
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: 2,
  })
}

export function useRailWindows(network: RailNetwork, instance: RailInstance) {
  return useQuery({
    queryKey: ['windows', network, instance],
    queryFn: () => readRail(network, instance).windows(),
    staleTime: Infinity,
    retry: 2,
  })
}

/** Operators currently allowed for a creditor, from OperatorSet events (paginated), newest state wins. */
export function useOperators(network: RailNetwork, instance: RailInstance, creditorId: bigint | undefined) {
  return useQuery({
    enabled: creditorId !== undefined,
    queryKey: ['operators', network, instance, creditorId?.toString()],
    queryFn: async (): Promise<Address[]> => {
      const client = getPublicClient(network)
      const address = railAddresses(network)[instance].rail
      const head = await client.getBlockNumber()
      const logs = await scanWindows(deploymentBlock(network), head, (f, t) =>
        client.getLogs({ address, event: operatorSet, args: { creditorId }, fromBlock: f, toBlock: t }),
      )
      const state = new Map<string, { op: Address; allowed: boolean }>()
      for (const l of logs) {
        if (l.args.operator) state.set(l.args.operator.toLowerCase(), { op: l.args.operator, allowed: !!l.args.allowed })
      }
      return [...state.values()].filter((s) => s.allowed).map((s) => s.op)
    },
    staleTime: 60_000,
    retry: 1,
  })
}

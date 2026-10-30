export const INSTALL = `git clone <your fork of this repo>
cd recall && bun install

# The SDK lives in packages/sdk and is imported as '@recall/sdk'.
# viem is its only dependency.`

export const CLIENT = `import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcMainnet, createRailClient } from '@recall/sdk'

const account = privateKeyToAccount(process.env.MERCHANT_KEY as \`0x\${string}\`)
const publicClient = createPublicClient({ chain: arcMainnet, transport: http() })
const walletClient = createWalletClient({ account, chain: arcMainnet, transport: http() })

// 'prod' = real time windows, 'demo' = 1 week is 1 minute
const rail = createRailClient({ network: 'arc', instance: 'prod', publicClient, walletClient })`

export const LINK = `import { debitRailAbi, encodeCheckoutLink, mandateTextForOffer, refToBytes32, Scheme, termsHash } from '@recall/sdk'

const name = (await publicClient.readContract({ address: rail.rail, abi: debitRailAbi, functionName: 'getCreditor', args: [1n] })).name

const draft = {
  creditorId: 1n, token: eurc, scheme: Scheme.CORE, oneOff: false,
  maxPerCollection: 25_000000n, maxPerPeriod: 50_000000n,
  periodLength: 30 * 86400, prenoticeLength: 14 * 86400,
  offerRef: refToBytes32('GYM-2026'), termsHash: '0x' + '00'.repeat(32),
  maxUses: 0, validUntil: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
  timeScale: rail.timeScale, debtor: '0x0000000000000000000000000000000000000000',
}
// The text is written from the offer's own fields, so it cannot promise what the offer doesn't.
const terms = mandateTextForOffer(draft, { creditorName: name, network: 'arc', instance: 'prod', rail: rail.rail, token: 'EURC' })
const offer = { ...draft, termsHash: termsHash(terms) }
const offerSig = await rail.signOffer(offer)

const link = encodeCheckoutLink('https://your.app/m', { network: 'arc', instance: 'prod', offer, offerSig, creditorName: name, terms })`

export const PRENOTIFY = `// announce a debit: amount, due date (at least the pre-notice from now), an end-to-end id, a note
const e2eId = refToBytes32('INV-2026-11-001')
await rail.prenotify(mandateId, 12_000000n, BigInt(dueAt), e2eId, 'Monthly membership')

// the payer can refuse it until it runs. On or after dueAt, anyone can collect:
const collectionId = rail.collectionId(mandateId, e2eId)
await rail.collect(collectionId)`

export const REFUND = `// the payer, within the refund window (8 weeks on prod): one call...
await rail.refund(collectionId)

// ...or one signature, submitted by anyone, no gas for the payer
const { action, debtor, sig } = await rail.signDebtorAction('REFUND', collectionId)
await rail.relayDebtorAction(action, debtor, sig) // POST /api/relay
// or: await rail.executeDebtorAction(action, debtor, sig) from any funded wallet`

export const ERRORS = `import { decodeRailError } from '@recall/sdk'

try {
  await rail.refund(collectionId)
} catch (e) {
  const { name, code, message } = decodeRailError(e)
  // name: 'RefundWindowClosed', code: null, message: 'The 8-week refund window has closed.'
}`

export interface McpTool {
  name: string
  input: string
  does: string
}

export const MCP_MERCHANT_TOOLS: McpTool[] = [
  { name: 'list_mandates', input: 'instance, creditorId, offset?, limit?', does: 'A creditor\u2019s mandates with their limits and recent collections.' },
  {
    name: 'prenotify_collection',
    input: 'instance, mandateId, amount, dueAt, remittanceInfo',
    does: 'Asks the rail first. If it would refuse (over the cap, notice too short, revoked...) returns the decoded refusal and sends nothing. Otherwise sends and returns the tx hash and collectionId.',
  },
  { name: 'collect_due', input: 'instance, creditorId', does: 'Collects every scheduled debit that is due. Per collection: SETTLED, or RETURNED with its code (AM04...).' },
  { name: 'list_returns', input: 'instance, creditorId', does: 'Returned and refused debits with their codes and what to do next, for dunning.' },
  { name: 'coverage', input: 'instance, creditorId', does: 'Free, locked, held and exposure per token.' },
]

export const MCP_PAYER_TOOLS: McpTool[] = [
  { name: 'list_my_debits', input: 'instance, payer', does: 'Every debit on a payer\u2019s mandates and whether each can still be refunded.' },
  { name: 'upcoming_debits', input: 'instance, payer', does: 'Announced debits that have not been collected yet, soonest first.' },
  { name: 'explain_refund_rights', input: 'instance, collectionId', does: 'In plain language: can it still be refunded, until when, and from what (reserve or held funds).' },
  {
    name: 'prepare_refund',
    input: 'instance, collectionId, payer',
    does: 'Returns the EIP-712 DebtorAction typed data and a link to /pay where the human signs. It never signs and never needs a key.',
  },
]

export const MCP_CONFIG = `{
  "mcpServers": {
    "recall": {
      "command": "bun",
      "args": ["run", "/ABSOLUTE/PATH/TO/recall/packages/mcp/src/index.ts"],
      "env": {
        "NETWORK": "arc",
        "RECALL_OPERATOR_KEY": "0x\u2026 an operator wallet, gas only"
      }
    }
  }
}`

export const MCP_INSTALL = `cd recall/packages/mcp && bun install
# Claude Desktop: claude_desktop_config.json   Cursor: ~/.cursor/mcp.json`

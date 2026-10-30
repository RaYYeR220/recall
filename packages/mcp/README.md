# Recall MCP server

An MCP server (stdio) that lets an AI agent work with Recall DebitRail, in two parts:

- **Merchant agent tools** act as an *operator* wallet. They can pre-notify, collect and cancel inside mandates payers have already signed. They cannot touch the reserve or the payout address, and cannot create a mandate or debit anyone who has not signed one.
- **Payer-assistant tools** are read-only. The payer's key is never given to this server and the server cannot sign for them: `prepare_refund` returns the typed data and a link, and the human signs in their own wallet.

It runs on Arc mainnet by default. Set `NETWORK=arc-testnet` for testnet.

## Install

```sh
git clone <this repository> recall && cd recall
bun install                      # app and SDK dependencies
cd packages/mcp && bun install   # MCP server dependencies
```

Check it starts (it waits for a client on stdin, so press Ctrl-C):

```sh
bun run src/index.ts
# recall-debitrail MCP ready on arc. No RECALL_OPERATOR_KEY: read-only tools only.
```

## Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "recall": {
      "command": "bun",
      "args": ["run", "/ABSOLUTE/PATH/TO/recall/packages/mcp/src/index.ts"],
      "env": {
        "NETWORK": "arc",
        "RECALL_OPERATOR_KEY": "0x…your operator wallet's private key…"
      }
    }
  }
}
```

If Claude Desktop cannot find `bun`, put the output of `which bun` in `command`.

## Cursor

Add the same block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "recall": {
      "command": "bun",
      "args": ["run", "/ABSOLUTE/PATH/TO/recall/packages/mcp/src/index.ts"],
      "env": {
        "NETWORK": "arc",
        "RECALL_OPERATOR_KEY": "0x…your operator wallet's private key…"
      }
    }
  }
}
```

Leave `RECALL_OPERATOR_KEY` out to run the read-only tools only (everything except `prenotify_collection` and `collect_due`).

## Environment

| Variable | Purpose |
| --- | --- |
| `NETWORK` | `arc` (default, mainnet) or `arc-testnet`. Anything else stops the server. |
| `RECALL_OPERATOR_KEY` | Private key of a wallet the creditor owner added as an operator (Merchant console, Operators). Only `prenotify_collection` and `collect_due` use it. Use a dedicated wallet that holds only gas. |
| `RPC_URL` | Optional RPC override. |
| `RECALL_APP_URL` | Optional. Where `prepare_refund` sends the payer to sign. Defaults to `https://recall-debit.vercel.app`. |

The key is read from the environment only. It is never printed, never returned by a tool, and the payer tools have no access to it.

## Tools

`instance` is `prod` or `demo` (the demo rail runs 10,080 times faster: 1 week = 1 minute). Amounts are decimals in the token, such as `"12.50"`. Times are ISO 8601.

### Merchant

| Tool | Input | What it does |
| --- | --- | --- |
| `list_mandates` | `instance, creditorId, offset?, limit?` | Mandates with limits and recent collections. Read-only. |
| `prenotify_collection` | `instance, mandateId, amount, dueAt, remittanceInfo, reference?` | Asks the rail first. If it would refuse (over the cap, notice too short, mandate revoked...) nothing is sent and the decoded refusal is returned. Otherwise sends and returns the tx hash and `collectionId`. A repeated `reference` is refused as a duplicate, so retries are safe. Needs the operator key. |
| `collect_due` | `instance, creditorId` | Collects every scheduled debit that is due (up to 25 per call). Per collection: `SETTLED`, `RETURNED` with its code (for example `AM04`), or the rail's refusal. Needs the operator key. |
| `list_returns` | `instance, creditorId` | Returned and refused debits with their codes and what to do next, for dunning. Read-only. |
| `coverage` | `instance, creditorId` | Free, locked, held and exposure per token. Read-only. |

### Payer assistant (read-only)

| Tool | Input | What it does |
| --- | --- | --- |
| `list_my_debits` | `instance, payer` | Every debit on the payer's mandates, and whether each can still be refunded. |
| `upcoming_debits` | `instance, payer` | Announced debits not yet collected, soonest first. |
| `explain_refund_rights` | `instance, collectionId` | In plain language: can it still be refunded, until when, and from what (reserve or held funds). |
| `prepare_refund` | `instance, collectionId, payer` | Returns the EIP-712 `DebtorAction` typed data and a link to `/pay` where the human signs. Never signs, never needs a key. Returns no typed data when the debit can no longer be refunded. |

## Tests

```sh
cd packages/mcp && bun test
```

Needs `anvil` and a `forge build` (the tests deploy both rails locally). They cover the tool schemas, input validation, every tool against a real rail, and that `prepare_refund` works with a context that has no key and no operator at all.

# Proof

Everything below is on **Arc mainnet** (chain 5042). Every claim links to the explorer.

## Contracts

All four are verified on Sourcify (exact match). Deployed in block 28299079 by 0xE6123988ECA9808f2654368812760a0971Aa8926.

| Contract | Address | Deploy tx |
|---|---|---|
| DebitRail — prod (timeScale 1, statutory windows) | [0x8a91eb44cf5d213c2230a42d1df84585224075b0](https://explorer.arc.io/address/0x8a91eb44cf5d213c2230a42d1df84585224075b0) · [Sourcify](https://repo.sourcify.dev/5042/0x8a91eb44cf5d213c2230a42d1df84585224075b0) | [0xe0b96762…](https://explorer.arc.io/tx/0xe0b96762c421d706991b7fcea5f75c83cb4fc5430eca893c363e54433d924373) |
| DebitRail — demo (timeScale 10080, 1 week = 1 minute) | [0x62a2e0a97138370f6b77823a1f1d4df6ca507667](https://explorer.arc.io/address/0x62a2e0a97138370f6b77823a1f1d4df6ca507667) · [Sourcify](https://repo.sourcify.dev/5042/0x62a2e0a97138370f6b77823a1f1d4df6ca507667) | [0xc6f0d37f…](https://explorer.arc.io/tx/0xc6f0d37fc8436777ac66c68680ed7286576966bcfdbf45c9ecf9bb06d2f8faac) |
| RailLens — prod | [0x806336c15b2a0972a8cf5abe609fa11af955cb6f](https://explorer.arc.io/address/0x806336c15b2a0972a8cf5abe609fa11af955cb6f) · [Sourcify](https://repo.sourcify.dev/5042/0x806336c15b2a0972a8cf5abe609fa11af955cb6f) | [0xc3c5a619…](https://explorer.arc.io/tx/0xc3c5a619db83cbecc8aec0843748f8160522d5d1d54777960f5116d93a0f776d) |
| RailLens — demo | [0xb97657400f385fe1db436b8c6924ff5c7c5c32cf](https://explorer.arc.io/address/0xb97657400f385fe1db436b8c6924ff5c7c5c32cf) · [Sourcify](https://repo.sourcify.dev/5042/0xb97657400f385fe1db436b8c6924ff5c7c5c32cf) | [0xf927a53e…](https://explorer.arc.io/tx/0xf927a53e6a0f4a36f59f774d3c969828f16ebed68327c766e9dd0096259a8852) |

## A real mandate on the prod rail

Northwind Gym (creditor #1) holds a 0.10 EURC reserve. The payer signed a mandate without paying gas; a relayer submitted it. A 0.05 EURC collection was pre-notified at least one day ahead, due 2026-10-29T11:57:01.000Z. It was collected on 2026-10-29; the payer can take it back until 2026-12-24, eight weeks of real time.

- Prod rail: creditor registered — [0xca02bd48…](https://explorer.arc.io/tx/0xca02bd4867cee19ee1d8f874217199d8fb31e2173b932f6d77245206503cbc6a)
- Prod rail: reserve funded (0.10 EURC) — [0xdf653a79…](https://explorer.arc.io/tx/0xdf653a794c854fe6268c933804254e1cf23b5a1547bdaaad414003f35fb50a0f)
- Prod rail: real mandate activated by relayer — [0x15f156b8…](https://explorer.arc.io/tx/0x15f156b87c98f7c44d3a77349712bd354d96ff748894fad32032e220e72153ca)
- Prod rail: collection pre-notified, due 2026-10-29T11:57:01.000Z — [0x5cf86545…](https://explorer.arc.io/tx/0x5cf865455e2a0db04f3587c2f9084d7706f48d933f8f4721aa364894dab6e435)
- Prod rail: collected — the payer can take it back until 2026-12-24T12:07:24.000Z — [0x182a652b…](https://explorer.arc.io/tx/0x182a652b27b35eb379afff750cbc3c2112f88e81368a27f0190368b031a18695)

## The full lifecycle on the demo rail

Same bytecode, compressed time, real EURC and USDC.

- Mandate signed by the payer, activated by a relayer (payer pays no gas) — [0xa3938d40…](https://explorer.arc.io/tx/0xa3938d408c2f06fe42585891bf36d0a9927b5b90ca251f1ed893bcc0f86e0ab7)
- Collection pre-notified (0.05 EURC) — [0x9065a539…](https://explorer.arc.io/tx/0x9065a5393c95159a58ce77ec233ed29c4a134b48a052976dec88912f962f1a76)
- Collected, fully covered by the merchant reserve — [0x09d56037…](https://explorer.arc.io/tx/0x09d56037ea6fad70e0a25c79a24751d8aacd04fbf24d3aac9f62a5af46d9eab8)
- Refunded by the payer with a signature, no gas (MD06) — [0xfa83161a…](https://explorer.arc.io/tx/0xfa83161af42a9813a32984e22cbc7d74231d31206e0aa95df3f0d3712e0800b2)
- Collected with a locked + held split (reserve too small) — [0x9f27c222…](https://explorer.arc.io/tx/0x9f27c222c1acde12eccc2defe4f483c953ae366dd129c3eb18e71e8a051d73d3)
- Released after the 8-week (demo: 8-minute) window — [0x0bc1ef5a…](https://explorer.arc.io/tx/0x0bc1ef5ad76eac979cb80e0a6647e8913000224c696cd8684b3e5e090b740b74)
- B2B one-off collected, final at once — [0xd5539933…](https://explorer.arc.io/tx/0xd5539933c0a0e96163022943150856c1b358b4ede12345eb7b3c7b45257012cc)
- Returned AM04: payer had no funds, nothing reverted — [0xaef72334…](https://explorer.arc.io/tx/0xaef7233476861c342d6a96685467439489c3a1bdf41459433b8b95f7dcb4895c)
- Payer refused an announced collection (MS02) — [0x312d6f8c…](https://explorer.arc.io/tx/0x312d6f8c06e68cdef68d8e82f19c76dde202e8790527b43068c2dc0e21111753)
- Payer revoked the mandate by signature — [0x3ce98afd…](https://explorer.arc.io/tx/0x3ce98afd8dab9d4838abf19bdf2e5916af51312cf39e88c1b2573613a503256a)

Two complete runs are recorded in [proof/arc-demo-lifecycle-run1.json](proof/arc-demo-lifecycle-run1.json) and [run2](proof/arc-demo-lifecycle-run2.json).

## Refusals, mined on mainnet

Each of these was sent as a real transaction and reverted with the named error.

| What was attempted | Error | Tx |
|---|---|---|
| demo rail rejects prod time scale | `WrongTimeScale` | [0x334e8cd2…](https://explorer.arc.io/tx/0x334e8cd2c6e99145e418e44c9dcc08eed96d67f65c8b58089b5f83d93b803551) |
| demo-signed offer replayed on prod | `BadSignature` | [0x569f5e60…](https://explorer.arc.io/tx/0x569f5e60459d54564ffbb1be0e9a671dfa0e2e1b8e2fdc382337f19daa3b2e80) |
| prenotify above the collection cap | `OverCollectionCap` | [0x93c6dec4…](https://explorer.arc.io/tx/0x93c6dec429ca04750eb277f34e9c8d43d0b1bd578c7cee484e1bd9e2d2e27a51) |
| collect before the due date | `TooEarly` | [0x7b23a2a0…](https://explorer.arc.io/tx/0x7b23a2a02f9863d0017162fb0b22205878a67d1c60252a4b4bc39164da330356) |
| withdraw the locked reserve | `ReserveLocked` | [0xc28b6e98…](https://explorer.arc.io/tx/0xc28b6e98a2135a76a4caec8fd56ced2100d6679adf02f552d9774c2705801319) |
| refund a B2B collection | `NoRefundRightB2B` | [0xf4c2ba79…](https://explorer.arc.io/tx/0xf4c2ba79ce5cdd44289fb9ae965aae9b813417a8d25cc5610afb8ceec74d853f) |
| refund after the window closed | `RefundWindowClosed` | [0x6932af9b…](https://explorer.arc.io/tx/0x6932af9b0fa6d9e894a9431774780f919b8476e066b5b983ca294777ceafda8a) |
| prenotify on a revoked mandate | `MD01_NoValidMandate` | [0x7c663c0a…](https://explorer.arc.io/tx/0x7c663c0a965059dc80d9932ef69ee89e2510ebe7dde1d045187c7dfcd129a424) |

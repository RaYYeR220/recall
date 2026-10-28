// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IDebitRail — types, events, errors, and full interface for Recall DebitRail
/// @notice Direct debit for stablecoins (EURC and USDC on Arc) with SEPA-Core refund rights.
///         Two instances share this code: prod (timeScale=1) and demo (timeScale=10080).

// ─────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────

/// @notice Payment scheme. CORE carries an 8-week refund right; B2B carries none.
enum Scheme { CORE, B2B }

/// @notice Lifecycle of a mandate (payer <-> merchant relationship).
enum MandateStatus { NONE, ACTIVE, REVOKED, USED }

/// @notice Lifecycle of a single collection.
enum CollectionStatus { NONE, SCHEDULED, REFUSED, CANCELLED, EXPIRED, RETURNED, SETTLED, REFUNDED, FINAL }

/// @notice The three actions a debtor can authorise via off-chain signature.
enum ActionKind { REFUND, REVOKE, REFUSE }

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

/// @notice Signed by the creditor (owner or operator) to create a mandate offer.
/// @dev    Encoded as an EIP-712 typed struct for off-chain signing and on-chain verification.
///
///         Fields:
///           creditorId       — registered creditor ID; anchors the offer to a specific merchant.
///           token            — EURC or USDC (the only two tokens accepted by the rail).
///           scheme           — CORE (8-week refund right) or B2B (immediate final, no refund).
///           oneOff           — if true, the mandate can only be collected once (becomes USED).
///           maxPerCollection — maximum amount collectible in a single collection.
///           maxPerPeriod     — maximum cumulative amount collectible in one period window.
///           periodLength     — period window length in LEGAL SECONDS (unscaled). The contract
///                              divides by timeScale at runtime. Period windows are fixed and
///                              anchored at the mandate's activatedAt timestamp. Because dueAt
///                              determines which period a collection belongs to, two collections
///                              whose dueAt values straddle a period boundary both count against
///                              their respective periods — up to 2x maxPerPeriod can therefore
///                              land in a short calendar window around a boundary.
///           prenoticeLength  — minimum advance notice in LEGAL SECONDS (unscaled).
///           offerRef         — creditor's own label for the offer. NOT a uniqueness key on-chain;
///                              the same debtor accepting two offers with the same offerRef will
///                              produce two distinct mandates (keyed by (offerHash, debtor)).
///           termsHash        — keccak256 of the human-readable mandate terms shown to the debtor.
///           maxUses          — 0 = unlimited; otherwise the offer expires after this many activations.
///           validUntil       — Unix timestamp after which the offer can no longer be activated.
///           timeScale        — MUST equal the target instance's timeScale (1 for prod, 10080 for
///                              demo). Included in the typed data so the wallet prompt displays it
///                              and a debtor cannot be tricked into signing for the wrong instance.
///           debtor           — address(0) = open offer (anyone may activate); non-zero = this
///                              specific debtor only. Prevents a third party from consuming a
///                              maxUses=1 offer intended for a particular payer.
///
///         Operator note: operators of a creditor (set via setOperator) may sign offers, cancel
///         any offer belonging to their creditor, prenotify, and cancel collections. They have
///         broad operational authority over the creditor's scheduling pipeline.
struct MandateOffer {
    uint256 creditorId;
    address token;
    Scheme  scheme;
    bool    oneOff;
    uint128 maxPerCollection;
    uint128 maxPerPeriod;
    uint32  periodLength;
    uint32  prenoticeLength;
    bytes32 offerRef;
    bytes32 termsHash;
    uint32  maxUses;
    uint64  validUntil;
    uint32  timeScale;   // NEW: must equal instance timeScale; shown in wallet prompt
    address debtor;      // NEW: address(0) = open; non-zero = specific debtor only
}

/// @notice Signed by the debtor to accept a mandate offer.
/// @dev    `offerHash` MUST equal `hashOffer(offer)` for the corresponding offer.
///         Uniqueness of the resulting mandate is (offerHash, debtor) — the same debtor
///         can accept two different offers with the same `offerRef` label.
struct MandateAcceptance {
    bytes32 offerHash;
    address debtor;
    uint64  deadline;
}

/// @notice Signed by the debtor to authorise a REFUND, REVOKE, or REFUSE without gas.
/// @dev    `nonce` MUST equal `nonces[debtor]` at submission time (consumed then incremented).
///         `target` is a collectionId for REFUND/REFUSE, a mandateId for REVOKE.
struct DebtorAction {
    ActionKind kind;
    bytes32    target;
    uint256    nonce;
    uint64     deadline;
}

/// @notice EIP-2612 permit parameters bundled for `activateMandateWithPermit`.
struct PermitData {
    uint256 value;
    uint256 deadline;
    uint8   v;
    bytes32 r;
    bytes32 s;
}

/// @notice On-chain record for a registered creditor (merchant).
struct Creditor {
    address owner;
    address payout;
    string  name;
}

/// @notice Full on-chain state of an activated mandate.
/// @dev    `lastActivityAt` is updated on every collect that reaches SETTLED or RETURNED
///         (AM04 / MS03) — i.e. any collect where the debtor was actually presented with a
///         collection attempt. It drives the 36-month lapse clock.
///         `activatedAt` is fixed at activation and drives period indexing.
struct Mandate {
    bytes32       offerHash;
    uint256       creditorId;
    address       debtor;
    address       token;
    Scheme        scheme;
    bool          oneOff;
    uint128       maxPerCollection;
    uint128       maxPerPeriod;
    uint32        periodLength;      // legal seconds (unscaled)
    uint32        prenoticeLength;   // legal seconds (unscaled)
    bytes32       offerRef;
    uint64        activatedAt;
    uint64        lastActivityAt;
    MandateStatus status;
}

/// @notice Full on-chain state of a collection (scheduled, in-flight, or terminal).
/// @dev    For CORE: `locked + held == amount` throughout the SETTLED -> {REFUNDED,FINAL} arc.
///         For B2B: both `locked` and `held` are 0; merchant is paid at once; status = FINAL.
///         `openExposure` is tracked at the Coverage level, not per-collection.
struct Collection {
    bytes32          mandateId;
    bytes32          e2eId;
    uint128          amount;
    uint64           dueAt;
    uint64           settledAt;
    uint128          locked;   // CORE: portion covered by reserve (refundable from reserve)
    uint128          held;     // CORE: portion held by contract (refundable from contract balance)
    CollectionStatus status;
    bytes4           code;     // ISO 20022 R-transaction reason code (populated on non-SETTLED outcomes)
}

/// @notice Reserve health for one (creditor, token) pair.
/// @dev    `openExposure` is CORE-only: it equals `reserveLocked + held` for any CORE pair,
///         and is always 0 for B2B pairs. Both B2B fields stay at 0 because the merchant
///         is paid immediately with no lock or hold.
///
///         Invariant I2: openExposure == reserveLocked + held  (CORE only)
///         Invariant I3: reserveLocked <= reserveTotal
struct Coverage {
    uint256 reserveTotal;
    uint256 reserveLocked;
    uint256 held;
    uint256 openExposure; // CORE only; always 0 for B2B
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

event CreditorRegistered(uint256 indexed creditorId, address indexed owner, address payout, string name);
event PayoutSet(uint256 indexed creditorId, address payout);
event OperatorSet(uint256 indexed creditorId, address indexed operator, bool allowed);
event OfferCancelled(bytes32 indexed offerHash);
event ReserveFunded(uint256 indexed creditorId, address indexed token, address from, uint256 amount);
event ReserveWithdrawn(uint256 indexed creditorId, address indexed token, address to, uint256 amount);

event MandateActivated(
    bytes32 indexed mandateId,
    bytes32 indexed offerHash,
    uint256 indexed creditorId,
    address debtor,
    address token,
    uint8   scheme
);
event MandateRevoked(bytes32 indexed mandateId, address by);

event CollectionScheduled(
    bytes32 indexed collectionId,
    bytes32 indexed mandateId,
    bytes32  e2eId,
    uint128  amount,
    uint64   dueAt,
    string   remittanceInfo
);
event CollectionRefused(bytes32 indexed collectionId);
event CollectionCancelled(bytes32 indexed collectionId);
event CollectionExpired(bytes32 indexed collectionId);
event CollectionReturned(bytes32 indexed collectionId, bytes4 code);
event CollectionSettled(bytes32 indexed collectionId, uint128 amount, uint128 locked, uint128 held);
event CollectionRefunded(bytes32 indexed collectionId, uint128 amount);
event CollectionReleased(bytes32 indexed collectionId, uint128 heldPaid);

event Claimed(address indexed account, address indexed token, uint256 amount);

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

error UnknownCreditor();
error NotCreditorOwner();
error NotCreditorAgent();          // caller is not the owner or an operator
error NotDebtor();
error NotDebtorOrCreditor();
error TokenNotAllowed();           // only EURC and USDC are accepted
error BadSignature();
error SignatureExpired();
error BadNonce();
error OfferCancelled_();           // offer was explicitly cancelled (avoids clash with the event name)
error OfferUsedUp();               // maxUses > 0 and already reached
error InvalidTerms();              // e.g. prenoticeLength < MIN_PRENOTICE, maxPerCollection == 0, demo caps breached
error MandateExists();             // (offerHash, debtor) pair already activated
error MD01_NoValidMandate();       // mandate not ACTIVE, or lapsed
error AM05_Duplicate();            // e2eId already used by this creditor
error ZeroAmount();
error ZeroAddress();
error OverCollectionCap();
error OverPeriodCap();
error PrenoticeTooShort();
error ScheduleTooFar();
error OneOffBusy();                // one-off mandate already has an open or settled collection
error WrongStatus();
error TooEarly();                  // collection's dueAt not yet reached
error ExecutionWindowPassed();     // collect called past dueAt + executionWindow
error RefundWindowOpen();          // release called before the refund window closes
error RefundWindowClosed();        // refund called after the refund window closes
error NoRefundRightB2B();          // refund called on a B2B collection
error ReserveLocked();             // withdraw would breach the locked portion
error NothingToClaim();
error WrongTimeScale();            // offer.timeScale != instance timeScale
error NotOfferedDebtor();          // offer.debtor != address(0) && acc.debtor != offer.debtor
error PermitFailed();              // permit did not produce sufficient allowance
error TransferFailed();            // claimable/withdrawReserve transfer failed (no fallback)

// ─────────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────────

interface IDebitRail {

    // -- Immutables ------------------------------------------------------------

    /// @notice Scaling factor for all time windows (1 = prod, 10080 = demo where 1 week -> 1 minute).
    function timeScale() external view returns (uint32);

    /// @notice Human label set at construction.
    function label() external view returns (string memory);

    // -- Scaled time windows --------------------------------------------------

    /// @notice Refund window in seconds: 8 weeks / timeScale.
    function refundWindow() external view returns (uint256);

    /// @notice Minimum pre-notice period in seconds: 1 day / timeScale (floor 1 s).
    function minPrenotice() external view returns (uint256);

    /// @notice Execution window in seconds: 5 days / timeScale (floor 15 min).
    function executionWindow() external view returns (uint256);

    /// @notice Mandate lapse period in seconds: 1080 days / timeScale.
    function lapsePeriod() external view returns (uint256);

    /// @notice Maximum schedule-ahead in seconds: 400 days / timeScale (floor 1 day).
    function scheduleAhead() external view returns (uint256);

    // -- Creditors and reserves -----------------------------------------------

    /// @notice Register a new creditor. Owner = msg.sender. IDs start at 1.
    function registerCreditor(string calldata name, address payout) external returns (uint256 creditorId);

    /// @notice Change the settlement payout address. Only the creditor owner.
    /// @dev    Reserve withdrawals are NOT restricted to this address -- see `withdrawReserve`.
    function setPayout(uint256 creditorId, address payout) external;

    /// @notice Grant or revoke an operator. Operators may sign offers, cancel any offer for their
    ///         creditor (regardless of who signed it), prenotify, and cancel collections.
    ///         They cannot touch the reserve or payout address.
    function setOperator(uint256 creditorId, address operator, bool allowed) external;

    /// @notice Deposit tokens into a creditor's reserve. Anyone may call.
    /// @dev    Pulls `amount` from msg.sender via transferFrom. Reserve is separate from
    ///         the payout address -- anyone can top it up without being the creditor owner.
    function fundReserve(uint256 creditorId, address token, uint256 amount) external;

    /// @notice Withdraw from the free (unlocked) portion of a creditor's reserve.
    ///         Only the creditor owner. `to` may be any address -- it need not be the payout.
    function withdrawReserve(uint256 creditorId, address token, uint256 amount, address to) external;

    /// @notice Pay out msg.sender's claimable balance for a token.
    ///         Claimable balances accumulate when a push transfer to a payout address fails
    ///         (e.g. blocklisted). Reverts TransferFailed if the transfer itself fails.
    function claim(address token) external;

    /// @notice Pay out `account`'s claimable balance to `account`. Anyone may call.
    ///         Useful when a payout address or exchange deposit address cannot call the contract.
    ///         Reverts TransferFailed if the transfer itself fails.
    function claimFor(address account, address token) external;

    // -- Offers and mandates --------------------------------------------------

    /// @notice Compute the EIP-712 struct hash for a MandateOffer.
    function hashOffer(MandateOffer calldata offer) external view returns (bytes32);

    /// @notice Compute the EIP-712 struct hash for a MandateAcceptance.
    function hashAcceptance(MandateAcceptance calldata acc) external view returns (bytes32);

    /// @notice Compute the EIP-712 struct hash for a DebtorAction.
    function hashDebtorAction(DebtorAction calldata a) external view returns (bytes32);

    /// @notice Cancel an offer so it can no longer be activated. Owner or operator only.
    function cancelOffer(MandateOffer calldata offer) external;

    /// @notice Activate a mandate from a signed offer + signed acceptance. Callable by anyone
    ///         (payer never needs gas). Returns a deterministic mandateId.
    /// @dev    mandateId = keccak256(abi.encode(offerHash, debtor))
    function activateMandate(
        MandateOffer    calldata offer,
        bytes           calldata offerSig,
        MandateAcceptance calldata acc,
        bytes           calldata debtorSig
    ) external returns (bytes32 mandateId);

    /// @notice Activate with EIP-2612 permit to set allowance atomically.
    ///         If the mandate (offerHash, acc.debtor) is already ACTIVE, skips activation and
    ///         returns the existing mandateId (idempotent on front-run). After the permit
    ///         try/catch, requires allowance(debtor, rail) >= permit.value; reverts PermitFailed
    ///         if the permit neither succeeded nor was already in effect.
    function activateMandateWithPermit(
        MandateOffer    calldata offer,
        bytes           calldata offerSig,
        MandateAcceptance calldata acc,
        bytes           calldata debtorSig,
        PermitData      calldata permit
    ) external returns (bytes32 mandateId);

    /// @notice Revoke a mandate. Callable by the debtor or the creditor owner.
    function revoke(bytes32 mandateId) external;

    // -- Collections ----------------------------------------------------------

    /// @notice Schedule a collection. Only the creditor owner or an operator.
    ///         collectionId = keccak256(abi.encode(mandateId, e2eId))
    function prenotify(
        bytes32 mandateId,
        uint128 amount,
        uint64  dueAt,
        bytes32 e2eId,
        string  calldata remittanceInfo
    ) external returns (bytes32 collectionId);

    /// @notice Refuse a SCHEDULED collection. Only the debtor.
    function refuse(bytes32 collectionId) external;

    /// @notice Cancel a SCHEDULED collection. Only the creditor owner or an operator.
    function cancel(bytes32 collectionId) external;

    /// @notice Execute a collection on or after its dueAt. Anyone may call.
    ///         Payer-side failures (insufficient funds, blocklist, revoked mandate) produce
    ///         a RETURNED status with an ISO 20022 code instead of reverting.
    function collect(bytes32 collectionId) external returns (CollectionStatus);

    /// @notice Claim a full refund on a CORE collection. Only the debtor. Must be within
    ///         the refund window (< settledAt + refundWindow()).
    function refund(bytes32 collectionId) external;

    /// @notice Release a SETTLED CORE collection after the refund window.
    ///         Pays held funds to the creditor payout; unlocks the reserve. Anyone may call.
    function release(bytes32 collectionId) external;

    /// @notice Mark a SCHEDULED collection EXPIRED once its execution window has passed.
    ///         Anyone may call.
    function expire(bytes32 collectionId) external;

    /// @notice Execute a debtor action (REFUND, REVOKE, or REFUSE) via an off-chain signature.
    ///         Anyone may submit -- the debtor never needs gas. Consumes one nonce.
    function executeDebtorAction(
        DebtorAction calldata a,
        address      debtor,
        bytes        calldata sig
    ) external;

    // -- Read views -----------------------------------------------------------

    function getCreditor(uint256 creditorId) external view returns (Creditor memory);
    function creditorCount() external view returns (uint256);
    function isOperator(uint256 creditorId, address who) external view returns (bool);

    function getMandate(bytes32 mandateId) external view returns (Mandate memory);
    function isLapsed(bytes32 mandateId) external view returns (bool);
    function getCollection(bytes32 collectionId) external view returns (Collection memory);

    function offerUses(bytes32 offerHash) external view returns (uint32);
    function offerCancelled(bytes32 offerHash) external view returns (bool);

    function coverage(uint256 creditorId, address token) external view returns (Coverage memory);
    function claimable(address account, address token) external view returns (uint256);
    function accounted(address token)
        external view returns (uint256 reserves, uint256 held, uint256 claimables);
    function lockedTotal(address token) external view returns (uint256);
    function exposureTotal(address token) external view returns (uint256);

    function mandatesOfDebtor(address debtor) external view returns (bytes32[] memory);
    function mandatesOfCreditor(uint256 creditorId) external view returns (bytes32[] memory);
    function collectionsOfMandate(bytes32 mandateId) external view returns (bytes32[] memory);

    /// @notice Count of SCHEDULED or SETTLED collections on a mandate (O(1) counter).
    function collectionsOpenCount(bytes32 mandateId) external view returns (uint32);

    function periodIndexOf(bytes32 mandateId, uint64 at) external view returns (uint256);
    function periodUsage(bytes32 mandateId, uint256 periodIndex) external view returns (uint256);
    function refundDeadline(bytes32 collectionId) external view returns (uint256);

    function nonces(address debtor) external view returns (uint256);

    function stats(address token)
        external view returns (
            uint256 collected,
            uint256 refunded,
            uint256 settledCount,
            uint256 refundedCount,
            uint256 returnedCount
        );
}

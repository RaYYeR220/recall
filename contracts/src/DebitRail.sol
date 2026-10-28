// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./IDebitRail.sol";

/// @title  DebitRail — Recall direct-debit rail for EURC and USDC on Arc
/// @notice Enforces SEPA Direct Debit Core rules in an immutable, ownerless contract.
///         Deploy twice: prod (timeScale=1) and demo (timeScale=10080, 1 week→1 minute).
/// @dev    No owner, no admin, no fees, no upgrades, no pause.
///         No receive() or fallback() — the contract rejects all native-value transfers.
///         On Arc, USDC IS the native gas token (same balance, two views). We never use
///         msg.value; every token flow goes through ERC-20 transferFrom/transfer.
///
///         Offer-signature rules:
///           - Owner:    verified via OpenZeppelin SignatureChecker (accepts both EOA and ERC-1271).
///           - Operators: EOA only, recovered via ECDSA.tryRecover (rejects high-s malleable sigs)
///             then checked against the operator mapping. ERC-1271 operators are not supported
///             because the operator mapping keys on address, not on a 1271 verifier result.
contract DebitRail is IDebitRail, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast  for uint256;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants (legal seconds)
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private constant REFUND_WINDOW      = 8 weeks;
    uint256 private constant MIN_PRENOTICE      = 1 days;
    uint256 private constant EXECUTION_WINDOW   = 5 days;
    uint256 private constant LAPSE_PERIOD       = 1080 days; // 36 × 30 days
    uint256 private constant MAX_SCHEDULE_AHEAD = 400 days;

    // Scaled-value floors
    uint256 private constant EXECUTION_WINDOW_FLOOR = 15 minutes;
    uint256 private constant SCHEDULE_AHEAD_FLOOR   = 1 days;
    uint256 private constant MIN_PRENOTICE_FLOOR    = 1; // 1 second

    // ISO 20022 R-transaction reason codes
    bytes4 private constant CODE_MD01 = bytes4("MD01"); // no valid mandate
    bytes4 private constant CODE_AM04 = bytes4("AM04"); // insufficient funds
    bytes4 private constant CODE_MS02 = bytes4("MS02"); // refused by debtor
    bytes4 private constant CODE_MS03 = bytes4("MS03"); // reason not specified
    bytes4 private constant CODE_MD06 = bytes4("MD06"); // refund requested by debtor
    bytes4 private constant CODE_AM05 = bytes4("AM05"); // duplicate (unused here but defined for completeness)

    // EIP-712 type hashes
    bytes32 private constant OFFER_TYPEHASH =
        keccak256(
            "MandateOffer(uint256 creditorId,address token,uint8 scheme,bool oneOff,"
            "uint128 maxPerCollection,uint128 maxPerPeriod,uint32 periodLength,"
            "uint32 prenoticeLength,bytes32 offerRef,bytes32 termsHash,uint32 maxUses,uint64 validUntil)"
        );

    bytes32 private constant ACCEPTANCE_TYPEHASH =
        keccak256("MandateAcceptance(bytes32 offerHash,address debtor,uint64 deadline)");

    bytes32 private constant DEBTOR_ACTION_TYPEHASH =
        keccak256("DebtorAction(uint8 kind,bytes32 target,uint256 nonce,uint64 deadline)");

    // ─────────────────────────────────────────────────────────────────────────
    // Immutables
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    uint32 public immutable override timeScale;

    /// @inheritdoc IDebitRail
    string public override label;

    address public immutable eurc;
    address public immutable usdc;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — creditors
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private _creditorCount;
    mapping(uint256 => Creditor)                          private _creditors;
    mapping(uint256 => mapping(address => bool))          private _operators;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — reserves (two packed 256-bit slots per (creditorId, token))
    // ─────────────────────────────────────────────────────────────────────────

    struct ReserveSlot {
        uint128 total;
        uint128 locked;
        uint128 held;
        /// @dev openExposure is CORE-only: always equals reserveLocked + held for any CORE pair.
        ///      Always 0 for B2B pairs — B2B pays the merchant in full with no lock or hold.
        uint128 openExposure;
    }
    mapping(uint256 => mapping(address => ReserveSlot))   private _reserves;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — global per-token accounting (O(1) shadow counters)
    // ─────────────────────────────────────────────────────────────────────────

    mapping(address => uint256) private _reservesTotalByToken;
    mapping(address => uint256) private _heldByToken;
    mapping(address => uint256) private _claimableByToken;
    mapping(address => uint256) private _lockedTotalByToken;
    mapping(address => uint256) private _exposureTotalByToken;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — offers
    // ─────────────────────────────────────────────────────────────────────────

    mapping(bytes32 => bool)   private _offerCancelled;
    mapping(bytes32 => uint32) private _offerUses;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — mandates
    // ─────────────────────────────────────────────────────────────────────────

    mapping(bytes32 => Mandate)    private _mandates;
    mapping(address  => bytes32[]) private _mandatesByDebtor;
    mapping(uint256  => bytes32[]) private _mandatesByCreditor;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — collections
    // ─────────────────────────────────────────────────────────────────────────

    mapping(bytes32 => Collection) private _collections;
    mapping(bytes32 => bytes32[])  private _collectionsByMandate;

    // periodUsage[mandateId][periodIndex] = cumulative scheduled amount in that period
    mapping(bytes32 => mapping(uint256 => uint128)) private _periodUsage;

    // _usedE2eIds[creditorId][e2eId] — uniqueness per creditor (mirrors SEPA end-to-end ID scope)
    mapping(uint256 => mapping(bytes32 => bool)) private _usedE2eIds;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — debtor nonces and claimable balances
    // ─────────────────────────────────────────────────────────────────────────

    mapping(address => uint256)                      private _nonces;
    mapping(address => mapping(address => uint256))  private _claimable;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — global stats per token
    // ─────────────────────────────────────────────────────────────────────────

    struct TokenStats {
        uint256 collected;
        uint256 refunded;
        uint256 settledCount;
        uint256 refundedCount;
        uint256 returnedCount;
    }
    mapping(address => TokenStats) private _stats;

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @param eurc_      EURC token address on Arc
    /// @param usdc_      USDC token address on Arc (0x3600...0000 — same pool as native gas)
    /// @param timeScale_ 1 for prod, 10080 for demo (1 week → 1 minute)
    /// @param label_     Human label ("prod" or "demo")
    constructor(address eurc_, address usdc_, uint32 timeScale_, string memory label_)
        EIP712("Recall DebitRail", "1")
    {
        require(eurc_ != address(0) && usdc_ != address(0), "ZeroAddress");
        require(timeScale_ > 0, "ZeroTimeScale");
        eurc      = eurc_;
        usdc      = usdc_;
        timeScale = timeScale_;
        label     = label_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scaled time windows
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function refundWindow() public view override returns (uint256) {
        return REFUND_WINDOW / timeScale;
    }

    /// @inheritdoc IDebitRail
    function minPrenotice() public view override returns (uint256) {
        uint256 s = MIN_PRENOTICE / timeScale;
        return s < MIN_PRENOTICE_FLOOR ? MIN_PRENOTICE_FLOOR : s;
    }

    /// @inheritdoc IDebitRail
    function executionWindow() public view override returns (uint256) {
        uint256 s = EXECUTION_WINDOW / timeScale;
        return s < EXECUTION_WINDOW_FLOOR ? EXECUTION_WINDOW_FLOOR : s;
    }

    /// @inheritdoc IDebitRail
    function lapsePeriod() public view override returns (uint256) {
        return LAPSE_PERIOD / timeScale;
    }

    /// @inheritdoc IDebitRail
    function scheduleAhead() public view override returns (uint256) {
        uint256 s = MAX_SCHEDULE_AHEAD / timeScale;
        return s < SCHEDULE_AHEAD_FLOOR ? SCHEDULE_AHEAD_FLOOR : s;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Creditor management
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function registerCreditor(string calldata name, address payout)
        external override returns (uint256 creditorId)
    {
        if (payout == address(0)) revert ZeroAddress();
        creditorId = ++_creditorCount;
        _creditors[creditorId] = Creditor({ owner: msg.sender, payout: payout, name: name });
        emit CreditorRegistered(creditorId, msg.sender, payout, name);
    }

    /// @inheritdoc IDebitRail
    function setPayout(uint256 creditorId, address payout) external override {
        _requireCreditorOwner(creditorId);
        if (payout == address(0)) revert ZeroAddress();
        _creditors[creditorId].payout = payout;
        emit PayoutSet(creditorId, payout);
    }

    /// @inheritdoc IDebitRail
    function setOperator(uint256 creditorId, address operator, bool allowed) external override {
        _requireCreditorOwner(creditorId);
        if (operator == address(0)) revert ZeroAddress();
        _operators[creditorId][operator] = allowed;
        emit OperatorSet(creditorId, operator, allowed);
    }

    /// @inheritdoc IDebitRail
    /// @dev Reserve funding is open to anyone; reserve management is separate from payout.
    ///      Anyone can top up a creditor's reserve without being the owner.
    function fundReserve(uint256 creditorId, address token, uint256 amount)
        external override nonReentrant
    {
        _requireKnownCreditor(creditorId);
        _requireAllowedToken(token);
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        ReserveSlot storage slot = _reserves[creditorId][token];
        // SafeCast: amount is the transferFrom'd value; overflow into uint128 is impossible
        // for any real stablecoin supply, but we cast safely.
        slot.total = (uint256(slot.total) + amount).toUint128();
        _reservesTotalByToken[token] += amount;

        emit ReserveFunded(creditorId, token, msg.sender, amount);
    }

    /// @inheritdoc IDebitRail
    /// @dev `to` may be any address — not restricted to the payout address.
    ///      This is intentional: reserve management is separate from settlement payout.
    function withdrawReserve(uint256 creditorId, address token, uint256 amount, address to)
        external override nonReentrant
    {
        _requireCreditorOwner(creditorId);
        _requireAllowedToken(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        ReserveSlot storage slot = _reserves[creditorId][token];
        uint256 free = uint256(slot.total) - uint256(slot.locked);
        if (amount > free) revert ReserveLocked();

        slot.total = (uint256(slot.total) - amount).toUint128();
        _reservesTotalByToken[token] -= amount;

        _pushToken(token, to, amount);
        emit ReserveWithdrawn(creditorId, token, to, amount);
    }

    /// @inheritdoc IDebitRail
    function claim(address token) external override nonReentrant {
        _requireAllowedToken(token);
        uint256 amount = _claimable[msg.sender][token];
        if (amount == 0) revert NothingToClaim();
        _claimable[msg.sender][token] = 0;
        _claimableByToken[token] -= amount;
        _pushToken(token, msg.sender, amount);
        emit Claimed(msg.sender, token, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EIP-712 hashing
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function hashOffer(MandateOffer calldata offer) public view override returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            OFFER_TYPEHASH,
            offer.creditorId,
            offer.token,
            uint8(offer.scheme),
            offer.oneOff,
            offer.maxPerCollection,
            offer.maxPerPeriod,
            offer.periodLength,
            offer.prenoticeLength,
            offer.offerRef,
            offer.termsHash,
            offer.maxUses,
            offer.validUntil
        )));
    }

    /// @inheritdoc IDebitRail
    function hashAcceptance(MandateAcceptance calldata acc) public view override returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ACCEPTANCE_TYPEHASH,
            acc.offerHash,
            acc.debtor,
            acc.deadline
        )));
    }

    /// @inheritdoc IDebitRail
    function hashDebtorAction(DebtorAction calldata a) public view override returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            DEBTOR_ACTION_TYPEHASH,
            uint8(a.kind),
            a.target,
            a.nonce,
            a.deadline
        )));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Offers
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function cancelOffer(MandateOffer calldata offer) external override {
        _requireCreditorAgent(offer.creditorId);
        bytes32 offerHash = hashOffer(offer);
        _offerCancelled[offerHash] = true;
        emit OfferCancelled(offerHash);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mandate activation
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function activateMandate(
        MandateOffer calldata offer,
        bytes calldata offerSig,
        MandateAcceptance calldata acc,
        bytes calldata debtorSig
    ) external override nonReentrant returns (bytes32 mandateId) {
        return _activate(offer, offerSig, acc, debtorSig);
    }

    /// @inheritdoc IDebitRail
    function activateMandateWithPermit(
        MandateOffer calldata offer,
        bytes calldata offerSig,
        MandateAcceptance calldata acc,
        bytes calldata debtorSig,
        PermitData calldata permit
    ) external override nonReentrant returns (bytes32 mandateId) {
        // Attempt the permit; swallow the revert if someone front-ran it.
        try IERC20Permit(offer.token).permit(
            acc.debtor, address(this),
            permit.value, permit.deadline,
            permit.v, permit.r, permit.s
        ) {} catch {}
        return _activate(offer, offerSig, acc, debtorSig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Revoke
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function revoke(bytes32 mandateId) external override {
        _revoke(mandateId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Collections
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function prenotify(
        bytes32 mandateId,
        uint128 amount,
        uint64  dueAt,
        bytes32 e2eId,
        string calldata remittanceInfo
    ) external override returns (bytes32 collectionId) {
        Mandate storage m = _mandates[mandateId];

        // Mandate must be ACTIVE and not lapsed
        if (m.status != MandateStatus.ACTIVE) revert MD01_NoValidMandate();
        if (_isLapsed(mandateId))             revert MD01_NoValidMandate();

        _requireCreditorAgent(m.creditorId);

        if (amount == 0)                      revert ZeroAmount();
        if (amount > m.maxPerCollection)      revert OverCollectionCap();

        // Pre-notice: dueAt must be at least minPrenotice(scaled) seconds ahead
        uint256 scaledPrenotice = uint256(m.prenoticeLength) / timeScale;
        if (scaledPrenotice < MIN_PRENOTICE_FLOOR) scaledPrenotice = MIN_PRENOTICE_FLOOR;
        if (dueAt < block.timestamp + scaledPrenotice) revert PrenoticeTooShort();

        // Schedule-ahead: dueAt must not be too far
        if (dueAt > block.timestamp + scheduleAhead()) revert ScheduleTooFar();

        // e2eId uniqueness per creditor
        if (_usedE2eIds[m.creditorId][e2eId]) revert AM05_Duplicate();

        // Period cap
        uint256 pidx = _periodIndexOf(mandateId, dueAt);
        uint128 used = _periodUsage[mandateId][pidx];
        if (uint256(used) + uint256(amount) > uint256(m.maxPerPeriod)) revert OverPeriodCap();

        // OneOff: cannot schedule if there is already an open or settled collection
        if (m.oneOff && _hasOpenOrSettled(mandateId)) revert OneOffBusy();

        // Record
        collectionId = keccak256(abi.encode(mandateId, e2eId));
        // Guard against collectionId collision (should be impossible but check anyway)
        if (_collections[collectionId].status != CollectionStatus.NONE) revert AM05_Duplicate();

        _usedE2eIds[m.creditorId][e2eId] = true;
        _periodUsage[mandateId][pidx] = used + amount;

        _collections[collectionId] = Collection({
            mandateId: mandateId,
            e2eId:     e2eId,
            amount:    amount,
            dueAt:     dueAt,
            settledAt: 0,
            locked:    0,
            held:      0,
            status:    CollectionStatus.SCHEDULED,
            code:      bytes4(0)
        });
        _collectionsByMandate[mandateId].push(collectionId);

        emit CollectionScheduled(collectionId, mandateId, e2eId, amount, dueAt, remittanceInfo);
    }

    /// @inheritdoc IDebitRail
    function refuse(bytes32 collectionId) external override {
        Collection storage col = _collections[collectionId];
        if (col.status != CollectionStatus.SCHEDULED) revert WrongStatus();

        Mandate storage m = _mandates[col.mandateId];
        if (msg.sender != m.debtor) revert NotDebtor();

        _releasePeriodUsage(col);
        col.status = CollectionStatus.REFUSED;
        col.code   = CODE_MS02;
        emit CollectionRefused(collectionId);
    }

    /// @inheritdoc IDebitRail
    function cancel(bytes32 collectionId) external override {
        Collection storage col = _collections[collectionId];
        if (col.status != CollectionStatus.SCHEDULED) revert WrongStatus();

        Mandate storage m = _mandates[col.mandateId];
        _requireCreditorAgent(m.creditorId);

        _releasePeriodUsage(col);
        col.status = CollectionStatus.CANCELLED;
        emit CollectionCancelled(collectionId);
    }

    /// @inheritdoc IDebitRail
    /// @dev Never reverts for payer-side problems — those become RETURNED with an ISO reason code.
    function collect(bytes32 collectionId) external override nonReentrant returns (CollectionStatus) {
        Collection storage col = _collections[collectionId];
        if (col.status != CollectionStatus.SCHEDULED) revert WrongStatus();
        if (block.timestamp < col.dueAt)                              revert TooEarly();
        if (block.timestamp > uint256(col.dueAt) + executionWindow()) revert ExecutionWindowPassed();
        return _collectInner(collectionId);
    }

    /// @dev Inner logic for collect(), extracted to avoid stack-too-deep.
    function _collectInner(bytes32 collectionId) internal returns (CollectionStatus) {
        Collection storage col = _collections[collectionId];
        Mandate    storage m   = _mandates[col.mandateId];

        // Check mandate validity
        if (m.status != MandateStatus.ACTIVE || _isLapsed(col.mandateId)) {
            return _returnCollection(col, collectionId, CODE_MD01);
        }

        // Check debtor balance
        if (IERC20(m.token).balanceOf(m.debtor) < col.amount) {
            return _returnCollection(col, collectionId, CODE_AM04);
        }

        // Attempt inbound transferFrom (low-level: failure → RETURNED MS03)
        {
            (bool tfOk, bytes memory tfRet) = m.token.call(
                abi.encodeWithSelector(IERC20.transferFrom.selector, m.debtor, address(this), uint256(col.amount))
            );
            if (!tfOk || !_decodeBoolReturn(tfRet)) {
                return _returnCollection(col, collectionId, CODE_MS03);
            }
        }

        // Settle
        uint64 now64 = uint64(block.timestamp);
        col.status       = CollectionStatus.SETTLED;
        col.settledAt    = now64;
        m.lastActivityAt = now64;
        if (m.oneOff) m.status = MandateStatus.USED;

        uint128 amt128 = col.amount;
        (uint128 locked128, uint128 held128) = _settleCoverage(col, m, m.token, amt128);

        // _settleCoverage sets col.status = FINAL for B2B; SETTLED for CORE.
        CollectionStatus finalStatus = col.status;

        TokenStats storage s = _stats[m.token];
        s.collected    += amt128;
        s.settledCount += 1;

        emit CollectionSettled(collectionId, amt128, locked128, held128);
        return finalStatus;
    }

    /// @inheritdoc IDebitRail
    /// @dev CORE only. Within the refund window. Pays held first then locked from reserve.
    function refund(bytes32 collectionId) external override nonReentrant {
        _refund(collectionId, msg.sender);
    }

    /// @inheritdoc IDebitRail
    function release(bytes32 collectionId) external override nonReentrant {
        Collection storage col = _collections[collectionId];
        if (col.status != CollectionStatus.SETTLED) revert WrongStatus();

        uint256 deadline = uint256(col.settledAt) + refundWindow();
        if (block.timestamp < deadline) revert RefundWindowOpen();

        Mandate storage m = _mandates[col.mandateId];
        address token     = m.token;
        uint128 locked128 = col.locked;
        uint128 held128   = col.held;
        uint128 amt128    = col.amount;

        col.status = CollectionStatus.FINAL;

        ReserveSlot storage slot = _reserves[m.creditorId][token];
        slot.locked       = (uint256(slot.locked)       - locked128).toUint128();
        slot.held         = (uint256(slot.held)          - held128).toUint128();
        slot.openExposure = (uint256(slot.openExposure)  - amt128).toUint128();

        _lockedTotalByToken[token]   -= locked128;
        _heldByToken[token]          -= held128;
        _exposureTotalByToken[token] -= amt128;

        // Pay held to merchant
        if (held128 > 0) {
            _pushToken(token, _creditors[m.creditorId].payout, held128);
        }

        emit CollectionReleased(collectionId, held128);
    }

    /// @inheritdoc IDebitRail
    function expire(bytes32 collectionId) external override {
        Collection storage col = _collections[collectionId];
        if (col.status != CollectionStatus.SCHEDULED) revert WrongStatus();
        if (block.timestamp <= uint256(col.dueAt) + executionWindow()) revert TooEarly();

        _releasePeriodUsage(col);
        col.status = CollectionStatus.EXPIRED;
        emit CollectionExpired(collectionId);
    }

    /// @inheritdoc IDebitRail
    /// @dev Anyone may submit. Nonce is consumed atomically.
    function executeDebtorAction(
        DebtorAction calldata a,
        address debtorAddr,
        bytes calldata sig
    ) external override nonReentrant {
        // Nonce check
        if (a.nonce != _nonces[debtorAddr]) revert BadNonce();
        _nonces[debtorAddr]++;

        // Deadline
        if (a.deadline < block.timestamp) revert SignatureExpired();

        // Signature verification (EOA or ERC-1271)
        bytes32 digest = hashDebtorAction(a);
        if (!SignatureChecker.isValidSignatureNow(debtorAddr, digest, sig)) revert BadSignature();

        // Dispatch
        if (a.kind == ActionKind.REFUND) {
            // target is a collectionId belonging to debtorAddr
            Collection storage col = _collections[a.target];
            if (_mandates[col.mandateId].debtor != debtorAddr) revert NotDebtor();
            _refund(a.target, debtorAddr);
        } else if (a.kind == ActionKind.REFUSE) {
            Collection storage col = _collections[a.target];
            if (_mandates[col.mandateId].debtor != debtorAddr) revert NotDebtor();
            _refuseInternal(a.target, debtorAddr);
        } else {
            // REVOKE: target is a mandateId belonging to debtorAddr
            if (_mandates[a.target].debtor != debtorAddr) revert NotDebtor();
            _revoke(a.target, debtorAddr);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function getCreditor(uint256 creditorId) external view override returns (Creditor memory) {
        _requireKnownCreditor(creditorId);
        return _creditors[creditorId];
    }

    function creditorCount() external view override returns (uint256) {
        return _creditorCount;
    }

    function isOperator(uint256 creditorId, address who) external view override returns (bool) {
        return _operators[creditorId][who];
    }

    function getMandate(bytes32 mandateId) external view override returns (Mandate memory) {
        return _mandates[mandateId];
    }

    function isLapsed(bytes32 mandateId) external view override returns (bool) {
        return _isLapsed(mandateId);
    }

    function getCollection(bytes32 collectionId) external view override returns (Collection memory) {
        return _collections[collectionId];
    }

    function offerUses(bytes32 offerHash) external view override returns (uint32) {
        return _offerUses[offerHash];
    }

    function offerCancelled(bytes32 offerHash) external view override returns (bool) {
        return _offerCancelled[offerHash];
    }

    function coverage(uint256 creditorId, address token)
        external view override returns (Coverage memory c)
    {
        ReserveSlot storage slot = _reserves[creditorId][token];
        c.reserveTotal  = slot.total;
        c.reserveLocked = slot.locked;
        c.held          = slot.held;
        c.openExposure  = slot.openExposure;
    }

    function claimable(address account, address token) external view override returns (uint256) {
        return _claimable[account][token];
    }

    function accounted(address token)
        external view override
        returns (uint256 reserves, uint256 held, uint256 claimables)
    {
        reserves   = _reservesTotalByToken[token];
        held       = _heldByToken[token];
        claimables = _claimableByToken[token];
    }

    function lockedTotal(address token) external view override returns (uint256) {
        return _lockedTotalByToken[token];
    }

    function exposureTotal(address token) external view override returns (uint256) {
        return _exposureTotalByToken[token];
    }

    function mandatesOfDebtor(address debtor) external view override returns (bytes32[] memory) {
        return _mandatesByDebtor[debtor];
    }

    function mandatesOfCreditor(uint256 creditorId)
        external view override returns (bytes32[] memory)
    {
        return _mandatesByCreditor[creditorId];
    }

    function collectionsOfMandate(bytes32 mandateId)
        external view override returns (bytes32[] memory)
    {
        return _collectionsByMandate[mandateId];
    }

    function periodIndexOf(bytes32 mandateId, uint64 at)
        external view override returns (uint256)
    {
        return _periodIndexOf(mandateId, at);
    }

    function periodUsage(bytes32 mandateId, uint256 pIdx)
        external view override returns (uint256)
    {
        return _periodUsage[mandateId][pIdx];
    }

    function refundDeadline(bytes32 collectionId) external view override returns (uint256) {
        Collection storage col = _collections[collectionId];
        if (col.settledAt == 0) return 0;
        // B2B: no refund right — settled and immediately final; deadline = settledAt.
        Mandate storage m = _mandates[col.mandateId];
        if (m.scheme == Scheme.B2B) return uint256(col.settledAt);
        return uint256(col.settledAt) + refundWindow();
    }

    function nonces(address debtor) external view override returns (uint256) {
        return _nonces[debtor];
    }

    function stats(address token)
        external view override
        returns (
            uint256 collected,
            uint256 refunded,
            uint256 settledCount,
            uint256 refundedCount,
            uint256 returnedCount
        )
    {
        TokenStats storage s = _stats[token];
        collected     = s.collected;
        refunded      = s.refunded;
        settledCount  = s.settledCount;
        refundedCount = s.refundedCount;
        returnedCount = s.returnedCount;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — activation
    // ─────────────────────────────────────────────────────────────────────────

    function _activate(
        MandateOffer calldata offer,
        bytes calldata offerSig,
        MandateAcceptance calldata acc,
        bytes calldata debtorSig
    ) internal returns (bytes32 mandateId) {
        // 1. Token allowed
        _requireAllowedToken(offer.token);

        // 2. Creditor exists
        _requireKnownCreditor(offer.creditorId);

        // 3. Terms
        if (offer.maxPerCollection == 0)                 revert InvalidTerms();
        if (offer.maxPerPeriod < offer.maxPerCollection) revert InvalidTerms();
        if (offer.periodLength == 0)                     revert InvalidTerms();
        if (offer.prenoticeLength < MIN_PRENOTICE)       revert InvalidTerms();

        // 4. Not cancelled
        bytes32 offerHash = hashOffer(offer);
        if (_offerCancelled[offerHash]) revert OfferCancelled_();

        // 5. validUntil
        if (offer.validUntil < block.timestamp) revert SignatureExpired();

        // 6. maxUses
        if (offer.maxUses > 0 && _offerUses[offerHash] >= offer.maxUses) revert OfferUsedUp();

        // 7. Verify offer signature
        //    Owner: EOA or ERC-1271 via SignatureChecker.
        //    Operator: EOA only, via ECDSA.tryRecover (rejects malleable high-s sigs).
        {
            address owner   = _creditors[offer.creditorId].owner;
            bool    ownerOk = SignatureChecker.isValidSignatureNow(owner, offerHash, offerSig);
            if (!ownerOk) {
                (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(offerHash, offerSig);
                if (err != ECDSA.RecoverError.NoError ||
                    recovered == address(0) ||
                    !_operators[offer.creditorId][recovered]) {
                    revert BadSignature();
                }
            }
        }

        // 8. Acceptance offerHash matches
        if (acc.offerHash != offerHash) revert BadSignature();

        // 9. Acceptance deadline
        if (acc.deadline < block.timestamp) revert SignatureExpired();

        // 10. Verify debtor signature (EOA or ERC-1271)
        bytes32 accHash = hashAcceptance(acc);
        if (!SignatureChecker.isValidSignatureNow(acc.debtor, accHash, debtorSig)) {
            revert BadSignature();
        }

        // 11. Mandate uniqueness
        mandateId = keccak256(abi.encode(offerHash, acc.debtor));
        if (_mandates[mandateId].status != MandateStatus.NONE) revert MandateExists();

        // 12. Record
        _offerUses[offerHash] += 1;
        uint64 now64 = uint64(block.timestamp);
        _mandates[mandateId] = Mandate({
            offerHash:        offerHash,
            creditorId:       offer.creditorId,
            debtor:           acc.debtor,
            token:            offer.token,
            scheme:           offer.scheme,
            oneOff:           offer.oneOff,
            maxPerCollection: offer.maxPerCollection,
            maxPerPeriod:     offer.maxPerPeriod,
            periodLength:     offer.periodLength,
            prenoticeLength:  offer.prenoticeLength,
            offerRef:         offer.offerRef,
            activatedAt:      now64,
            lastActivityAt:   now64,
            status:           MandateStatus.ACTIVE
        });

        _mandatesByDebtor[acc.debtor].push(mandateId);
        _mandatesByCreditor[offer.creditorId].push(mandateId);

        emit MandateActivated(
            mandateId, offerHash, offer.creditorId,
            acc.debtor, offer.token, uint8(offer.scheme)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — revoke
    // ─────────────────────────────────────────────────────────────────────────

    function _revoke(bytes32 mandateId, address caller) internal {
        Mandate storage m = _mandates[mandateId];
        if (m.status == MandateStatus.NONE)   revert MD01_NoValidMandate();
        if (m.status != MandateStatus.ACTIVE) revert WrongStatus();

        bool isDebtor = (caller == m.debtor);
        bool isOwner  = (caller == _creditors[m.creditorId].owner);
        if (!isDebtor && !isOwner) revert NotDebtorOrCreditor();

        m.status = MandateStatus.REVOKED;
        emit MandateRevoked(mandateId, caller);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — coverage split on SETTLED
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Applies the CORE/B2B coverage split, updates per-creditor and global shadow counters,
    ///      and pushes the immediately-payable portion to the creditor payout.
    ///      Returns (locked, held) for event emission in collect().
    function _settleCoverage(
        Collection storage col,
        Mandate storage m,
        address token,
        uint128 amt128
    ) internal returns (uint128 locked128, uint128 held128) {
        if (m.scheme == Scheme.CORE) {
            ReserveSlot storage slot = _reserves[m.creditorId][token];
            uint256 free = uint256(slot.total) - uint256(slot.locked);
            locked128 = uint256(amt128) > free ? free.toUint128() : amt128;
            held128   = amt128 - locked128;

            col.locked = locked128;
            col.held   = held128;

            slot.locked       = (uint256(slot.locked)       + locked128).toUint128();
            slot.held         = (uint256(slot.held)          + held128).toUint128();
            slot.openExposure = (uint256(slot.openExposure)  + amt128).toUint128();

            _lockedTotalByToken[token]   += locked128;
            _heldByToken[token]          += held128;
            _exposureTotalByToken[token] += amt128;

            // Pay the non-held portion to the creditor payout now
            uint256 payNow = uint256(amt128) - uint256(held128);
            if (payNow > 0) {
                _pushToken(token, _creditors[m.creditorId].payout, payNow);
            }
        } else {
            // B2B: full immediate payment, no lock, no hold.
            // Go straight to FINAL — there is no refund right and therefore no release step.
            // openExposure is never touched for B2B, so no underflow risk in release().
            col.locked = 0;
            col.held   = 0;
            col.status = CollectionStatus.FINAL;
            locked128  = 0;
            held128    = 0;
            _pushToken(token, _creditors[m.creditorId].payout, uint256(amt128));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — refund
    // ─────────────────────────────────────────────────────────────────────────

    function _refund(bytes32 collectionId, address caller) internal {
        Collection storage col = _collections[collectionId];

        // Check scheme BEFORE status: a B2B collection is FINAL (never SETTLED),
        // so checking status first would give a misleading WrongStatus error.
        Mandate storage m = _mandates[col.mandateId];
        if (m.scheme == Scheme.B2B)          revert NoRefundRightB2B();
        if (col.status != CollectionStatus.SETTLED) revert WrongStatus();
        if (caller != m.debtor)              revert NotDebtor();

        uint256 deadline = uint256(col.settledAt) + refundWindow();
        if (block.timestamp >= deadline)     revert RefundWindowClosed();

        address token    = m.token;
        uint128 amt128   = col.amount;
        uint128 locked128= col.locked;
        uint128 held128  = col.held;

        col.status = CollectionStatus.REFUNDED;
        col.code   = CODE_MD06;

        // Unwind coverage
        ReserveSlot storage slot = _reserves[m.creditorId][token];
        slot.total        = (uint256(slot.total)       - locked128).toUint128();
        slot.locked       = (uint256(slot.locked)      - locked128).toUint128();
        slot.held         = (uint256(slot.held)         - held128).toUint128();
        slot.openExposure = (uint256(slot.openExposure) - amt128).toUint128();

        _reservesTotalByToken[token] -= locked128;
        _lockedTotalByToken[token]   -= locked128;
        _heldByToken[token]          -= held128;
        _exposureTotalByToken[token] -= amt128;

        // Stats
        TokenStats storage s = _stats[token];
        s.refunded      += amt128;
        s.refundedCount += 1;

        // Pay debtor the full amount (held from contract balance + locked from reserve)
        _pushToken(token, m.debtor, uint256(amt128));

        emit CollectionRefunded(collectionId, amt128);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — refuse (shared by direct call and executeDebtorAction)
    // ─────────────────────────────────────────────────────────────────────────

    function _refuseInternal(bytes32 collectionId, address caller) internal {
        Collection storage col = _collections[collectionId];
        if (col.status != CollectionStatus.SCHEDULED) revert WrongStatus();
        if (caller != _mandates[col.mandateId].debtor) revert NotDebtor();

        _releasePeriodUsage(col);
        col.status = CollectionStatus.REFUSED;
        col.code   = CODE_MS02;
        emit CollectionRefused(collectionId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — period usage helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _releasePeriodUsage(Collection storage col) internal {
        bytes32 mid  = col.mandateId;
        uint256 pidx = _periodIndexOf(mid, col.dueAt);
        uint128 used = _periodUsage[mid][pidx];
        uint128 amt  = col.amount;
        _periodUsage[mid][pidx] = used > amt ? used - amt : 0;
    }

    function _returnCollection(
        Collection storage col,
        bytes32 collectionId,
        bytes4 code
    ) internal returns (CollectionStatus) {
        _releasePeriodUsage(col);
        col.status = CollectionStatus.RETURNED;
        col.code   = code;
        _stats[_mandates[col.mandateId].token].returnedCount += 1;
        emit CollectionReturned(collectionId, code);
        return CollectionStatus.RETURNED;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — oneOff busy check
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Returns true if the mandate has any collection in SCHEDULED or SETTLED state.
    function _hasOpenOrSettled(bytes32 mandateId) internal view returns (bool) {
        bytes32[] storage ids = _collectionsByMandate[mandateId];
        for (uint256 i; i < ids.length; ++i) {
            CollectionStatus st = _collections[ids[i]].status;
            if (st == CollectionStatus.SCHEDULED || st == CollectionStatus.SETTLED) return true;
        }
        return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _requireKnownCreditor(uint256 creditorId) internal view {
        if (creditorId == 0 || creditorId > _creditorCount) revert UnknownCreditor();
    }

    function _requireCreditorOwner(uint256 creditorId) internal view {
        _requireKnownCreditor(creditorId);
        if (_creditors[creditorId].owner != msg.sender) revert NotCreditorOwner();
    }

    function _requireCreditorAgent(uint256 creditorId) internal view {
        _requireKnownCreditor(creditorId);
        address owner = _creditors[creditorId].owner;
        if (msg.sender != owner && !_operators[creditorId][msg.sender]) revert NotCreditorAgent();
    }

    function _requireAllowedToken(address token) internal view {
        if (token != eurc && token != usdc) revert TokenNotAllowed();
    }

    function _isLapsed(bytes32 mandateId) internal view returns (bool) {
        Mandate storage m = _mandates[mandateId];
        if (m.status == MandateStatus.NONE) return false;
        return block.timestamp > uint256(m.lastActivityAt) + lapsePeriod();
    }

    function _periodIndexOf(bytes32 mandateId, uint64 at) internal view returns (uint256) {
        Mandate storage m = _mandates[mandateId];
        uint256 sp = uint256(m.periodLength) / timeScale;
        if (sp == 0) sp = 1;
        return (uint256(at) - uint256(m.activatedAt)) / sp;
    }

    /// @dev Push an ERC-20 transfer to `to`. On any failure (revert OR returned false),
    ///      credit `to`'s claimable balance instead so the call never bubbles up.
    ///      Pattern: low-level call; success iff ok && (no return data || abi.decode bool true).
    function _pushToken(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (ok && _decodeBoolReturn(ret)) return; // success
        // Failure: credit claimable
        _claimable[to][token]    += amount;
        _claimableByToken[token] += amount;
    }

    /// @dev Decode the return data of a transfer/transferFrom call.
    ///      ERC-20 allows no return data (returns nothing) which counts as success,
    ///      or a bool return — true = success, false = failure.
    function _decodeBoolReturn(bytes memory ret) internal pure returns (bool) {
        if (ret.length == 0)   return true;   // no return data → success (bare ERC-20)
        if (ret.length == 32)  return abi.decode(ret, (bool));
        return false; // unexpected return length → treat as failure
    }
}

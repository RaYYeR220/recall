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

/// @title  DebitRail -- Recall direct-debit rail for EURC and USDC on Arc
/// @notice Enforces SEPA Direct Debit Core rules in an immutable, ownerless contract.
///         Deploy twice: prod (timeScale=1) and demo (timeScale=10080, 1 week->1 minute).
/// @dev    No owner, no admin, no fees, no upgrades, no pause.
///         No receive() or fallback() -- the contract rejects all native-value transfers.
///         On Arc, USDC IS the native gas token (same balance, two views). We never use
///         msg.value; every token flow goes through ERC-20 transferFrom/transfer.
///
///         Signature verification (_isValidSig):
///           1. ECDSA.tryRecover -- if the recovered address equals signer, valid.
///           2. Only if (1) fails AND signer has code, fall through to ERC-1271.
///         This correctly handles EIP-7702 delegated EOAs (which have code but should be
///         verified as EOAs first). A plain EOA that hasn't delegated will never reach the
///         ERC-1271 path. Pure ERC-1271 wallets with no valid ECDSA key work via step (2).
///
///         Offer-signature rules (same logic, two keys checked):
///           - Owner: _isValidSig(owner, offerHash, sig).
///           - Operators: ECDSA.tryRecover only (EOA, high-s rejected). ERC-1271 operators
///             are not supported because the operator map keys on address.
contract DebitRail is IDebitRail, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast  for uint256;

    // -------------------------------------------------------------------------
    // Constants (legal seconds)
    // -------------------------------------------------------------------------

    uint256 private constant REFUND_WINDOW      = 8 weeks;
    uint256 private constant MIN_PRENOTICE      = 1 days;
    uint256 private constant EXECUTION_WINDOW   = 5 days;
    uint256 private constant LAPSE_PERIOD       = 1080 days; // 36 x 30 days
    uint256 private constant MAX_SCHEDULE_AHEAD = 400 days;

    // Scaled-value floors
    uint256 private constant EXECUTION_WINDOW_FLOOR = 15 minutes;
    uint256 private constant SCHEDULE_AHEAD_FLOOR   = 1 days;
    uint256 private constant MIN_PRENOTICE_FLOOR    = 1; // 1 second

    // Demo hard-caps (apply when timeScale > 1)
    uint128 private constant DEMO_MAX_PER_COLLECTION = 1_000_000;  // 1 USDC/EURC (6 dec)
    uint128 private constant DEMO_MAX_PER_PERIOD     = 2_000_000;  // 2 USDC/EURC (6 dec)

    // ISO 20022 R-transaction reason codes
    bytes4 private constant CODE_MD01 = bytes4("MD01");
    bytes4 private constant CODE_AM04 = bytes4("AM04");
    bytes4 private constant CODE_MS02 = bytes4("MS02");
    bytes4 private constant CODE_MS03 = bytes4("MS03");
    bytes4 private constant CODE_MD06 = bytes4("MD06");

    // EIP-712 type hashes (include new timeScale and debtor fields)
    bytes32 private constant OFFER_TYPEHASH =
        keccak256(
            "MandateOffer(uint256 creditorId,address token,uint8 scheme,bool oneOff,"
            "uint128 maxPerCollection,uint128 maxPerPeriod,uint32 periodLength,"
            "uint32 prenoticeLength,bytes32 offerRef,bytes32 termsHash,uint32 maxUses,"
            "uint64 validUntil,uint32 timeScale,address debtor)"
        );

    bytes32 private constant ACCEPTANCE_TYPEHASH =
        keccak256("MandateAcceptance(bytes32 offerHash,address debtor,uint64 deadline)");

    bytes32 private constant DEBTOR_ACTION_TYPEHASH =
        keccak256("DebtorAction(uint8 kind,bytes32 target,uint256 nonce,uint64 deadline)");

    // -------------------------------------------------------------------------
    // Immutables
    // -------------------------------------------------------------------------

    /// @inheritdoc IDebitRail
    uint32 public immutable override timeScale;

    /// @inheritdoc IDebitRail
    string public override label;

    address public immutable eurc;
    address public immutable usdc;

    // -------------------------------------------------------------------------
    // Storage -- creditors
    // -------------------------------------------------------------------------

    uint256 private _creditorCount;
    mapping(uint256 => Creditor)                         private _creditors;
    mapping(uint256 => mapping(address => bool))         private _operators;

    // -------------------------------------------------------------------------
    // Storage -- reserves
    // -------------------------------------------------------------------------

    struct ReserveSlot {
        uint128 total;
        uint128 locked;
        uint128 held;
        /// @dev openExposure is CORE-only: always equals reserveLocked + held for any CORE pair.
        ///      Always 0 for B2B pairs.
        uint128 openExposure;
    }
    mapping(uint256 => mapping(address => ReserveSlot))  private _reserves;

    // -------------------------------------------------------------------------
    // Storage -- global per-token accounting (O(1) shadow counters)
    // -------------------------------------------------------------------------

    mapping(address => uint256) private _reservesTotalByToken;
    mapping(address => uint256) private _heldByToken;
    mapping(address => uint256) private _claimableByToken;
    mapping(address => uint256) private _lockedTotalByToken;
    mapping(address => uint256) private _exposureTotalByToken;

    // -------------------------------------------------------------------------
    // Storage -- offers
    // -------------------------------------------------------------------------

    mapping(bytes32 => bool)   private _offerCancelled;
    mapping(bytes32 => uint32) private _offerUses;

    // -------------------------------------------------------------------------
    // Storage -- mandates
    // -------------------------------------------------------------------------

    mapping(bytes32 => Mandate)    private _mandates;
    mapping(address  => bytes32[]) private _mandatesByDebtor;
    mapping(uint256  => bytes32[]) private _mandatesByCreditor;

    // -------------------------------------------------------------------------
    // Storage -- collections
    // -------------------------------------------------------------------------

    mapping(bytes32 => Collection) private _collections;
    mapping(bytes32 => bytes32[])  private _collectionsByMandate;

    // O(1) counter of SCHEDULED + SETTLED collections per mandate (replaces loop in _hasOpenOrSettled)
    mapping(bytes32 => uint32) private _openCount;

    // periodUsage[mandateId][periodIndex] = cumulative scheduled amount in that period
    mapping(bytes32 => mapping(uint256 => uint128)) private _periodUsage;

    // _usedE2eIds[creditorId][e2eId] -- uniqueness per creditor
    mapping(uint256 => mapping(bytes32 => bool)) private _usedE2eIds;

    // -------------------------------------------------------------------------
    // Storage -- debtor nonces and claimable balances
    // -------------------------------------------------------------------------

    mapping(address => uint256)                     private _nonces;
    mapping(address => mapping(address => uint256)) private _claimable;

    // -------------------------------------------------------------------------
    // Storage -- global stats per token
    // -------------------------------------------------------------------------

    struct TokenStats {
        uint256 collected;
        uint256 refunded;
        uint256 settledCount;
        uint256 refundedCount;
        uint256 returnedCount;
    }
    mapping(address => TokenStats) private _stats;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param eurc_       EURC token address on Arc (must have code)
    /// @param usdc_       USDC token address on Arc (must have code)
    /// @param timeScale_  1 for prod, 10080 for demo (1 week -> 1 minute)
    /// @param domainName_ EIP-712 domain name shown in wallet prompts; must be non-empty.
    ///                    Prod: "Recall DebitRail"   Demo: "Recall DebitRail DEMO (1 week = 1 minute)"
    /// @param label_      Short human label stored on-chain ("prod" or "demo")
    constructor(
        address eurc_,
        address usdc_,
        uint32  timeScale_,
        string  memory domainName_,
        string  memory label_
    )
        EIP712(domainName_, "1")
    {
        require(eurc_ != address(0) && usdc_ != address(0), "ZeroAddress");
        require(eurc_.code.length > 0 && usdc_.code.length > 0, "NoCode");
        require(timeScale_ > 0, "ZeroTimeScale");
        require(bytes(domainName_).length > 0, "EmptyDomainName");
        eurc      = eurc_;
        usdc      = usdc_;
        timeScale = timeScale_;
        label     = label_;
    }

    // -------------------------------------------------------------------------
    // Scaled time windows
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Creditor management
    // -------------------------------------------------------------------------

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
    function fundReserve(uint256 creditorId, address token, uint256 amount)
        external override nonReentrant
    {
        _requireKnownCreditor(creditorId);
        _requireAllowedToken(token);
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        ReserveSlot storage slot = _reserves[creditorId][token];
        slot.total = (uint256(slot.total) + amount).toUint128();
        _reservesTotalByToken[token] += amount;

        emit ReserveFunded(creditorId, token, msg.sender, amount);
    }

    /// @inheritdoc IDebitRail
    /// @dev `to` may be any address -- not restricted to the payout address. Intentional:
    ///      reserve management is separate from settlement payout.
    ///      Reverts TransferFailed if the transfer itself fails (no claimable fallback).
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

        _pushTokenStrict(token, to, amount);
        emit ReserveWithdrawn(creditorId, token, to, amount);
    }

    /// @inheritdoc IDebitRail
    /// @dev Claimable balances accumulate only from collect/refund/release push failures.
    ///      Reverts TransferFailed if the transfer itself fails (no re-crediting).
    function claim(address token) external override nonReentrant {
        _claimOut(msg.sender, token);
    }

    /// @inheritdoc IDebitRail
    function claimFor(address account, address token) external override nonReentrant {
        if (account == address(0)) revert ZeroAddress();
        _claimOut(account, token);
    }

    // -------------------------------------------------------------------------
    // EIP-712 hashing
    // -------------------------------------------------------------------------

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
            offer.validUntil,
            offer.timeScale,
            offer.debtor
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

    // -------------------------------------------------------------------------
    // Offers
    // -------------------------------------------------------------------------

    /// @inheritdoc IDebitRail
    function cancelOffer(MandateOffer calldata offer) external override {
        _requireCreditorAgent(offer.creditorId);
        bytes32 offerHash = hashOffer(offer);
        _offerCancelled[offerHash] = true;
        emit OfferCancelled(offerHash);
    }

    // -------------------------------------------------------------------------
    // Mandate activation
    // -------------------------------------------------------------------------

    /// @inheritdoc IDebitRail
    function activateMandate(
        MandateOffer      calldata offer,
        bytes             calldata offerSig,
        MandateAcceptance calldata acc,
        bytes             calldata debtorSig
    ) external override nonReentrant returns (bytes32 mandateId) {
        return _activate(offer, offerSig, acc, debtorSig);
    }

    /// @inheritdoc IDebitRail
    function activateMandateWithPermit(
        MandateOffer      calldata offer,
        bytes             calldata offerSig,
        MandateAcceptance calldata acc,
        bytes             calldata debtorSig,
        PermitData        calldata permit
    ) external override nonReentrant returns (bytes32 mandateId) {
        // Check token is allowed before calling permit on an arbitrary address.
        _requireAllowedToken(offer.token);

        // Compute mandateId early to check for idempotency.
        bytes32 offerHash  = hashOffer(offer);
        mandateId = keccak256(abi.encode(offerHash, acc.debtor));

        // If already ACTIVE (front-run scenario), attempt permit and return existing id.
        if (_mandates[mandateId].status == MandateStatus.ACTIVE) {
            try IERC20Permit(offer.token).permit(
                acc.debtor, address(this),
                permit.value, permit.deadline,
                permit.v, permit.r, permit.s
            ) {} catch {}
            return mandateId;
        }

        // Attempt the permit; swallow the revert if someone front-ran it.
        try IERC20Permit(offer.token).permit(
            acc.debtor, address(this),
            permit.value, permit.deadline,
            permit.v, permit.r, permit.s
        ) {} catch {}

        // Require that the permit produced sufficient allowance (either this call or a prior one).
        uint256 allowance = IERC20(offer.token).allowance(acc.debtor, address(this));
        if (allowance < permit.value) revert PermitFailed();

        return _activate(offer, offerSig, acc, debtorSig);
    }

    // -------------------------------------------------------------------------
    // Revoke
    // -------------------------------------------------------------------------

    /// @inheritdoc IDebitRail
    function revoke(bytes32 mandateId) external override {
        _revoke(mandateId, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Collections
    // -------------------------------------------------------------------------

    /// @inheritdoc IDebitRail
    function prenotify(
        bytes32 mandateId,
        uint128 amount,
        uint64  dueAt,
        bytes32 e2eId,
        string  calldata remittanceInfo
    ) external override returns (bytes32 collectionId) {
        Mandate storage m = _mandates[mandateId];

        if (m.status != MandateStatus.ACTIVE) revert MD01_NoValidMandate();
        if (_isLapsed(mandateId))             revert MD01_NoValidMandate();

        _requireCreditorAgent(m.creditorId);

        if (amount == 0)                 revert ZeroAmount();
        if (amount > m.maxPerCollection) revert OverCollectionCap();

        uint256 scaledPrenotice = uint256(m.prenoticeLength) / timeScale;
        if (scaledPrenotice < MIN_PRENOTICE_FLOOR) scaledPrenotice = MIN_PRENOTICE_FLOOR;
        if (dueAt < block.timestamp + scaledPrenotice) revert PrenoticeTooShort();
        if (dueAt > block.timestamp + scheduleAhead()) revert ScheduleTooFar();

        if (_usedE2eIds[m.creditorId][e2eId]) revert AM05_Duplicate();

        uint256 pidx = _periodIndexOf(mandateId, dueAt);
        uint128 used = _periodUsage[mandateId][pidx];
        if (uint256(used) + uint256(amount) > uint256(m.maxPerPeriod)) revert OverPeriodCap();

        // O(1) one-off check via counter
        if (m.oneOff && _openCount[mandateId] > 0) revert OneOffBusy();

        collectionId = keccak256(abi.encode(mandateId, e2eId));
        if (_collections[collectionId].status != CollectionStatus.NONE) revert AM05_Duplicate();

        _usedE2eIds[m.creditorId][e2eId] = true;
        _periodUsage[mandateId][pidx] = used + amount;
        _openCount[mandateId] += 1;

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
        _openCount[col.mandateId] -= 1;
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
        _openCount[col.mandateId] -= 1;
        col.status = CollectionStatus.CANCELLED;
        emit CollectionCancelled(collectionId);
    }

    /// @inheritdoc IDebitRail
    /// @dev Never reverts for payer-side problems -- those become RETURNED with an ISO reason code.
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
            // Update lastActivityAt even on MD01 -- a presented collection counts as activity.
            m.lastActivityAt = uint64(block.timestamp);
            return _returnCollection(col, collectionId, CODE_MD01);
        }

        // Check debtor balance
        if (IERC20(m.token).balanceOf(m.debtor) < col.amount) {
            m.lastActivityAt = uint64(block.timestamp);
            return _returnCollection(col, collectionId, CODE_AM04);
        }

        // Attempt inbound transferFrom (low-level: failure -> RETURNED MS03)
        {
            (bool tfOk, bytes memory tfRet) = m.token.call(
                abi.encodeWithSelector(
                    IERC20.transferFrom.selector,
                    m.debtor, address(this), uint256(col.amount)
                )
            );
            if (!tfOk || !_decodeBoolReturn(tfRet)) {
                m.lastActivityAt = uint64(block.timestamp);
                return _returnCollection(col, collectionId, CODE_MS03);
            }
        }

        // Settle
        uint64 now64 = uint64(block.timestamp);
        col.status       = CollectionStatus.SETTLED;
        col.settledAt    = now64;
        m.lastActivityAt = now64;
        if (m.oneOff) m.status = MandateStatus.USED;

        // NOTE: _openCount stays incremented for SETTLED (still "open" until FINAL/REFUNDED).
        // It is decremented only when the collection leaves the SETTLED state.

        uint128 amt128 = col.amount;
        (uint128 locked128, uint128 held128) = _settleCoverage(col, m, m.token, amt128);

        CollectionStatus finalStatus = col.status;

        // For B2B, _settleCoverage sets status=FINAL -- decrement open count now.
        if (finalStatus == CollectionStatus.FINAL) {
            _openCount[col.mandateId] -= 1;
        }

        TokenStats storage s = _stats[m.token];
        s.collected    += amt128;
        s.settledCount += 1;

        emit CollectionSettled(collectionId, amt128, locked128, held128);
        return finalStatus;
    }

    /// @inheritdoc IDebitRail
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
        _openCount[col.mandateId] -= 1;

        ReserveSlot storage slot = _reserves[m.creditorId][token];
        slot.locked       = (uint256(slot.locked)      - locked128).toUint128();
        slot.held         = (uint256(slot.held)         - held128).toUint128();
        slot.openExposure = (uint256(slot.openExposure) - amt128).toUint128();

        _lockedTotalByToken[token]   -= locked128;
        _heldByToken[token]          -= held128;
        _exposureTotalByToken[token] -= amt128;

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
        _openCount[col.mandateId] -= 1;
        col.status = CollectionStatus.EXPIRED;
        emit CollectionExpired(collectionId);
    }

    /// @inheritdoc IDebitRail
    function executeDebtorAction(
        DebtorAction calldata a,
        address      debtorAddr,
        bytes        calldata sig
    ) external override nonReentrant {
        if (a.nonce != _nonces[debtorAddr]) revert BadNonce();
        _nonces[debtorAddr]++;

        if (a.deadline < block.timestamp) revert SignatureExpired();

        bytes32 digest = hashDebtorAction(a);
        if (!_isValidSig(debtorAddr, digest, sig)) revert BadSignature();

        if (a.kind == ActionKind.REFUND) {
            Collection storage col = _collections[a.target];
            if (_mandates[col.mandateId].debtor != debtorAddr) revert NotDebtor();
            _refund(a.target, debtorAddr);
        } else if (a.kind == ActionKind.REFUSE) {
            Collection storage col = _collections[a.target];
            if (_mandates[col.mandateId].debtor != debtorAddr) revert NotDebtor();
            _refuseInternal(a.target, debtorAddr);
        } else {
            if (_mandates[a.target].debtor != debtorAddr) revert NotDebtor();
            _revoke(a.target, debtorAddr);
        }
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getCreditor(uint256 creditorId) external view override returns (Creditor memory) {
        _requireKnownCreditor(creditorId);
        return _creditors[creditorId];
    }

    function creditorCount() external view override returns (uint256) { return _creditorCount; }

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

    function collectionsOpenCount(bytes32 mandateId) external view override returns (uint32) {
        return _openCount[mandateId];
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

    // -------------------------------------------------------------------------
    // Internal -- signature verification
    // -------------------------------------------------------------------------

    /// @dev Unified signature check that correctly handles EIP-7702 delegated EOAs.
    ///      Step 1: ECDSA.tryRecover -- if recovered == signer, valid (EOA path).
    ///      Step 2: Only if step 1 fails AND signer has code, try ERC-1271 (contract wallet path).
    ///      A delegated EOA (7702) has code but should pass step 1 if the key is valid.
    function _isValidSig(address signer, bytes32 digest, bytes calldata sig)
        internal view returns (bool)
    {
        // Step 1: ECDSA recovery (EOA path, incl. 7702-delegated EOAs with a valid key)
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return true;

        // Step 2: ERC-1271 (pure contract wallets)
        if (signer.code.length > 0) {
            return SignatureChecker.isValidSignatureNow(signer, digest, sig);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Internal -- activation
    // -------------------------------------------------------------------------

    function _activate(
        MandateOffer      calldata offer,
        bytes             calldata offerSig,
        MandateAcceptance calldata acc,
        bytes             calldata debtorSig
    ) internal returns (bytes32 mandateId) {
        _requireAllowedToken(offer.token);
        _requireKnownCreditor(offer.creditorId);

        // Terms
        if (offer.maxPerCollection == 0)                 revert InvalidTerms();
        if (offer.maxPerPeriod < offer.maxPerCollection) revert InvalidTerms();
        if (offer.periodLength == 0)                     revert InvalidTerms();
        if (offer.prenoticeLength < MIN_PRENOTICE)       revert InvalidTerms();

        // timeScale must match this instance
        if (offer.timeScale != timeScale) revert WrongTimeScale();

        // Demo hard-caps
        if (timeScale > 1) {
            if (offer.maxPerCollection > DEMO_MAX_PER_COLLECTION) revert InvalidTerms();
            if (offer.maxPerPeriod     > DEMO_MAX_PER_PERIOD)     revert InvalidTerms();
        }

        bytes32 offerHash = hashOffer(offer);
        if (_offerCancelled[offerHash]) revert OfferCancelled_();
        if (offer.validUntil < block.timestamp) revert SignatureExpired();
        if (offer.maxUses > 0 && _offerUses[offerHash] >= offer.maxUses) revert OfferUsedUp();

        // Offer signature: owner via _isValidSig; operator via ECDSA only
        {
            address owner = _creditors[offer.creditorId].owner;
            if (!_isValidSig(owner, offerHash, offerSig)) {
                (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(offerHash, offerSig);
                if (err != ECDSA.RecoverError.NoError ||
                    recovered == address(0) ||
                    !_operators[offer.creditorId][recovered])
                {
                    revert BadSignature();
                }
            }
        }

        // Acceptance
        if (acc.offerHash != offerHash) revert BadSignature();
        if (acc.deadline < block.timestamp) revert SignatureExpired();

        // Specific-debtor check
        if (offer.debtor != address(0) && acc.debtor != offer.debtor) revert NotOfferedDebtor();

        // Debtor signature via _isValidSig (handles 7702)
        bytes32 accHash = hashAcceptance(acc);
        if (!_isValidSig(acc.debtor, accHash, debtorSig)) revert BadSignature();

        mandateId = keccak256(abi.encode(offerHash, acc.debtor));
        if (_mandates[mandateId].status != MandateStatus.NONE) revert MandateExists();

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

    // -------------------------------------------------------------------------
    // Internal -- revoke
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Internal -- coverage split on SETTLED
    // -------------------------------------------------------------------------

    function _settleCoverage(
        Collection storage col,
        Mandate    storage m,
        address    token,
        uint128    amt128
    ) internal returns (uint128 locked128, uint128 held128) {
        if (m.scheme == Scheme.CORE) {
            ReserveSlot storage slot = _reserves[m.creditorId][token];
            uint256 free = uint256(slot.total) - uint256(slot.locked);
            locked128 = uint256(amt128) > free ? free.toUint128() : amt128;
            held128   = amt128 - locked128;

            col.locked = locked128;
            col.held   = held128;

            slot.locked       = (uint256(slot.locked)      + locked128).toUint128();
            slot.held         = (uint256(slot.held)         + held128).toUint128();
            slot.openExposure = (uint256(slot.openExposure) + amt128).toUint128();

            _lockedTotalByToken[token]   += locked128;
            _heldByToken[token]          += held128;
            _exposureTotalByToken[token] += amt128;

            uint256 payNow = uint256(amt128) - uint256(held128);
            if (payNow > 0) {
                _pushToken(token, _creditors[m.creditorId].payout, payNow);
            }
        } else {
            // B2B: immediate full payment, no lock, no hold, straight to FINAL.
            col.locked = 0;
            col.held   = 0;
            col.status = CollectionStatus.FINAL;
            locked128  = 0;
            held128    = 0;
            _pushToken(token, _creditors[m.creditorId].payout, uint256(amt128));
        }
    }

    // -------------------------------------------------------------------------
    // Internal -- refund
    // -------------------------------------------------------------------------

    function _refund(bytes32 collectionId, address caller) internal {
        Collection storage col = _collections[collectionId];

        Mandate storage m = _mandates[col.mandateId];
        if (m.scheme == Scheme.B2B)                    revert NoRefundRightB2B();
        if (col.status != CollectionStatus.SETTLED)    revert WrongStatus();
        if (caller != m.debtor)                        revert NotDebtor();

        uint256 deadline = uint256(col.settledAt) + refundWindow();
        if (block.timestamp >= deadline)               revert RefundWindowClosed();

        address token     = m.token;
        uint128 amt128    = col.amount;
        uint128 locked128 = col.locked;
        uint128 held128   = col.held;

        col.status = CollectionStatus.REFUNDED;
        col.code   = CODE_MD06;
        _openCount[col.mandateId] -= 1;

        ReserveSlot storage slot = _reserves[m.creditorId][token];
        slot.total        = (uint256(slot.total)       - locked128).toUint128();
        slot.locked       = (uint256(slot.locked)      - locked128).toUint128();
        slot.held         = (uint256(slot.held)         - held128).toUint128();
        slot.openExposure = (uint256(slot.openExposure) - amt128).toUint128();

        _reservesTotalByToken[token] -= locked128;
        _lockedTotalByToken[token]   -= locked128;
        _heldByToken[token]          -= held128;
        _exposureTotalByToken[token] -= amt128;

        TokenStats storage s = _stats[token];
        s.refunded      += amt128;
        s.refundedCount += 1;

        _pushToken(token, m.debtor, uint256(amt128));

        emit CollectionRefunded(collectionId, amt128);
    }

    // -------------------------------------------------------------------------
    // Internal -- refuse
    // -------------------------------------------------------------------------

    function _refuseInternal(bytes32 collectionId, address caller) internal {
        Collection storage col = _collections[collectionId];
        if (col.status != CollectionStatus.SCHEDULED) revert WrongStatus();
        if (caller != _mandates[col.mandateId].debtor) revert NotDebtor();

        _releasePeriodUsage(col);
        _openCount[col.mandateId] -= 1;
        col.status = CollectionStatus.REFUSED;
        col.code   = CODE_MS02;
        emit CollectionRefused(collectionId);
    }

    // -------------------------------------------------------------------------
    // Internal -- period usage
    // -------------------------------------------------------------------------

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
        bytes4  code
    ) internal returns (CollectionStatus) {
        _releasePeriodUsage(col);
        _openCount[col.mandateId] -= 1;
        col.status = CollectionStatus.RETURNED;
        col.code   = code;
        _stats[_mandates[col.mandateId].token].returnedCount += 1;
        emit CollectionReturned(collectionId, code);
        return CollectionStatus.RETURNED;
    }

    // -------------------------------------------------------------------------
    // Internal -- claim helper
    // -------------------------------------------------------------------------

    function _claimOut(address account, address token) internal {
        _requireAllowedToken(token);
        uint256 amount = _claimable[account][token];
        if (amount == 0) revert NothingToClaim();
        _claimable[account][token] = 0;
        _claimableByToken[token] -= amount;
        _pushTokenStrict(token, account, amount);
        emit Claimed(account, token, amount);
    }

    // -------------------------------------------------------------------------
    // Internal -- helpers
    // -------------------------------------------------------------------------

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

    /// @dev Push a token transfer with the claimable fallback (used for collect/refund/release payouts).
    function _pushToken(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (ok && _decodeBoolReturn(ret)) return;
        _claimable[to][token]    += amount;
        _claimableByToken[token] += amount;
    }

    /// @dev Push a token transfer that MUST succeed -- used for claim, claimFor, withdrawReserve.
    ///      No claimable fallback; reverts TransferFailed on any failure.
    function _pushTokenStrict(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (ok && _decodeBoolReturn(ret)) return;
        revert TransferFailed();
    }

    function _decodeBoolReturn(bytes memory ret) internal pure returns (bool) {
        if (ret.length == 0)  return true;
        if (ret.length == 32) return abi.decode(ret, (bool));
        return false;
    }
}

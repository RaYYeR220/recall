// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DebitRail.sol";
import "../src/IDebitRail.sol";
import "./mocks/MockFiatToken.sol";
import "./mocks/Mock1271Wallet.sol";

/// @notice Shared base: deploys prod + demo rails on the same mocks,
///         provides signing helpers for offers, acceptances, permits and debtor actions.
///         All actors carry both an address and a derivable private key so vm.sign works.
abstract contract DebitRailBase is Test {

    // ── Tokens ──────────────────────────────────────────────────────────────

    MockFiatToken internal eurc;
    MockFiatToken internal usdc;

    // ── Rails ───────────────────────────────────────────────────────────────

    DebitRail internal prod;  // timeScale = 1
    DebitRail internal demo;  // timeScale = 10080

    // ── Actor keys + addresses ───────────────────────────────────────────────

    uint256 internal creditorOwnerKey = uint256(keccak256("creditorOwner"));
    address internal creditorOwner;

    uint256 internal creditorOwner2Key = uint256(keccak256("creditorOwner2"));
    address internal creditorOwner2;

    uint256 internal operatorKey = uint256(keccak256("operator"));
    address internal operator;

    uint256 internal strangerKey = uint256(keccak256("stranger"));
    address internal stranger;

    uint256 internal debtorKey = uint256(keccak256("debtor"));
    address internal debtor;

    uint256 internal debtor2Key = uint256(keccak256("debtor2"));
    address internal debtor2;

    address internal creditorPayout  = makeAddr("creditorPayout");
    address internal creditorPayout2 = makeAddr("creditorPayout2");

    // Shared creditor IDs set by helpers
    uint256 internal creditorId1;
    uint256 internal creditorId2;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public virtual {
        creditorOwner  = vm.addr(creditorOwnerKey);
        creditorOwner2 = vm.addr(creditorOwner2Key);
        operator       = vm.addr(operatorKey);
        stranger       = vm.addr(strangerKey);
        debtor         = vm.addr(debtorKey);
        debtor2        = vm.addr(debtor2Key);

        eurc = new MockFiatToken("EURC", "EURC");
        usdc = new MockFiatToken("USDC", "USDC");

        prod = new DebitRail(address(eurc), address(usdc), 1,     "Recall DebitRail", "prod");
        demo = new DebitRail(address(eurc), address(usdc), 10080, "Recall DebitRail DEMO (1 week = 1 minute)", "demo");

        // Fund actors
        eurc.mint(debtor,  1_000e6);
        usdc.mint(debtor,  1_000e6);
        eurc.mint(debtor2, 1_000e6);
        usdc.mint(debtor2, 1_000e6);

        eurc.mint(creditorOwner, 100_000e6);
        usdc.mint(creditorOwner, 100_000e6);
    }

    // ── Signing helpers ──────────────────────────────────────────────────────

    /// @notice Sign a MandateOffer (EIP-712) for a given rail.
    function _signOffer(DebitRail rail, MandateOffer memory offer, uint256 signerKey)
        internal view returns (bytes memory)
    {
        bytes32 digest = rail.hashOffer(offer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Sign a MandateAcceptance (EIP-712) for a given rail.
    function _signAcceptance(DebitRail rail, MandateAcceptance memory acc, uint256 signerKey)
        internal view returns (bytes memory)
    {
        bytes32 digest = rail.hashAcceptance(acc);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Sign a DebtorAction (EIP-712) for a given rail.
    function _signDebtorAction(DebitRail rail, DebtorAction memory action, uint256 signerKey)
        internal view returns (bytes memory)
    {
        bytes32 digest = rail.hashDebtorAction(action);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Build an EIP-2612 permit signature over `token` for `spender`.
    function _signPermit(
        MockFiatToken token_,
        address owner_,
        uint256 ownerKey,
        address spender,
        uint256 value,
        uint256 deadline
    ) internal view returns (PermitData memory p) {
        p.value    = value;
        p.deadline = deadline;

        bytes32 domainSep = token_.DOMAIN_SEPARATOR();
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            owner_,
            spender,
            value,
            token_.nonces(owner_),
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (p.v, p.r, p.s) = vm.sign(ownerKey, digest);
    }

    // ── Offer / acceptance builder helpers ───────────────────────────────────

    /// @notice Build a standard CORE EURC offer for creditorId1 on prod.
    function _defaultOffer() internal view returns (MandateOffer memory) {
        return MandateOffer({
            creditorId:       creditorId1,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: 100e6,
            maxPerPeriod:     200e6,
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32("REF-001"),
            termsHash:        keccak256("terms"),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        1,       // prod instance
            debtor:           address(0) // open offer
        });
    }

    /// @notice Build an acceptance for `who` on the given offerHash.
    function _acceptance(bytes32 offerHash, address who)
        internal view returns (MandateAcceptance memory)
    {
        return MandateAcceptance({
            offerHash: offerHash,
            debtor:    who,
            deadline:  uint64(block.timestamp + 1 days)
        });
    }

    // ── Registration helpers ─────────────────────────────────────────────────

    function _registerCreditor1() internal returns (uint256 id) {
        vm.prank(creditorOwner);
        id = prod.registerCreditor("Merchant A", creditorPayout);
        creditorId1 = id;
    }

    function _registerCreditor2() internal returns (uint256 id) {
        vm.prank(creditorOwner2);
        id = prod.registerCreditor("Merchant B", creditorPayout2);
        creditorId2 = id;
    }

    // ── Full activation helper ───────────────────────────────────────────────

    /// @notice Activate a mandate on prod with default offer/acceptance.
    ///         creditorId1 must already be set.
    function _activateMandate(
        DebitRail rail,
        MandateOffer memory offer,
        uint256 offerSignerKey,
        address debtorAddr,
        uint256 debtorSignerKey
    ) internal returns (bytes32 mandateId) {
        bytes32 offerHash  = rail.hashOffer(offer);
        bytes memory offerSig = _signOffer(rail, offer, offerSignerKey);

        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtorAddr,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(rail, acc, debtorSignerKey);

        mandateId = rail.activateMandate(offer, offerSig, acc, debtorSig);
    }
}

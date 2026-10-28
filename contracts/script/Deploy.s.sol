// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/DebitRail.sol";
import "../src/RailLens.sol";

/// @notice Deploys prod + demo DebitRail instances and their RailLenses.
///         Run with:
///           EURC_ADDRESS=0x... USDC_ADDRESS=0x... \
///           forge script contracts/script/Deploy.s.sol \
///             --rpc-url arc_testnet --broadcast \
///             --private-key $DEPLOYER_KEY \
///             --gas-price 20000000000
///
///         Outputs deployments/<chainId>.json.
contract Deploy is Script {
    function run() external {
        address eurc = vm.envAddress("EURC_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");

        uint256 chainId = block.chainid;
        console.log("Deploying to chain:", chainId);
        console.log("EURC:", eurc);
        console.log("USDC:", usdc);
        console.log("Deployer:", msg.sender);

        vm.startBroadcast();

        DebitRail prodRail = new DebitRail(
            eurc,
            usdc,
            1,
            "Recall DebitRail",
            "prod"
        );

        DebitRail demoRail = new DebitRail(
            eurc,
            usdc,
            10080,
            "Recall DebitRail DEMO (1 week = 1 minute)",
            "demo"
        );

        RailLens prodLens = new RailLens(address(prodRail));
        RailLens demoLens = new RailLens(address(demoRail));

        vm.stopBroadcast();

        console.log("prod.rail:", address(prodRail));
        console.log("prod.lens:", address(prodLens));
        console.log("demo.rail:", address(demoRail));
        console.log("demo.lens:", address(demoLens));

        // Write deployment manifest
        string memory json = string(abi.encodePacked(
            '{"chainId":', vm.toString(chainId),
            ',"deployer":"', vm.toString(msg.sender),
            '","block":', vm.toString(block.number),
            ',"eurc":"', vm.toString(eurc),
            '","usdc":"', vm.toString(usdc),
            '","prod":{"rail":"', vm.toString(address(prodRail)),
            '","lens":"', vm.toString(address(prodLens)),
            '"},"demo":{"rail":"', vm.toString(address(demoRail)),
            '","lens":"', vm.toString(address(demoLens)),
            '"}}'
        ));

        string memory outPath = string(abi.encodePacked(
            vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json"
        ));
        vm.writeFile(outPath, json);
        console.log("Manifest written to", outPath);
    }
}

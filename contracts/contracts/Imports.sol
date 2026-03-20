// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Re-export goo-contracts for Hardhat compilation and artifact generation.
// This file exists solely so Hardhat discovers these contracts.

import "goo-contracts/src/GooAgentToken.sol";
import "goo-contracts/src/GooAgentRegistry.sol";
import "goo-contracts/src/SwapExecutorV2.sol";
import "goo-contracts/src/mocks/MockStable.sol";
import "goo-contracts/src/mocks/MockRouter.sol";
import "goo-contracts/src/mocks/MockSwapExecutor.sol";

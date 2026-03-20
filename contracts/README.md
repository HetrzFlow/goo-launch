<p align="center"><img src="../assets/logo.png" alt="Goo Economy" width="120" /></p>

# contracts/

This directory is the Hardhat project for `goo-example`. It does **not** contain its own contract implementations — it uses:

- [`goo-contracts`](../../packages/goo-contracts) — Goo Economic Agent on-chain economic life: token standard + registry interfaces + reference implementations (`GooAgentToken`, `GooAgentRegistry`)
- [`goo-core`](../../packages/goo-core) — Off-chain economic life (survival economics, economic awareness, autonomous behavior)

## Setup

```bash
npm install          # Installs goo-contracts (local link) + OpenZeppelin + Hardhat
npm run compile      # Compile contracts
npm run test         # Run tests
```

## How It Works

`goo-contracts` is installed as a local npm dependency (see `package.json`). You can import interfaces and reference implementations directly:

```solidity
// Import interfaces
import "goo-contracts/src/interfaces/IGooAgentToken.sol";
import "goo-contracts/src/interfaces/IGooAgentRegistry.sol";

// Import reference implementations (for deployment)
import "goo-contracts/src/GooAgentToken.sol";
import "goo-contracts/src/GooAgentRegistry.sol";

// Import mocks (for testing)
import "goo-contracts/src/mocks/MockStable.sol";
import "goo-contracts/src/mocks/MockRouter.sol";
```

## Layout

| Path                | Description                                         |
| ------------------- | --------------------------------------------------- |
| `scripts/`          | Deploy scripts (uses goo-contracts reference impls) |
| `test/`             | Hardhat test suites                                 |
| `hardhat.config.ts` | Compiler + network configuration                    |

## Compiler

- Solidity 0.8.28, viaIR, Cancun EVM, 200 optimizer runs

## Networks

| Network     | Chain ID | Env Var               |
| ----------- | -------- | --------------------- |
| BSC Testnet | 97       | `BSC_TESTNET_RPC_URL` |
| BSC Mainnet | 56       | `BSC_RPC`             |

Set `DEPLOYER_PRIVATE_KEY` or `PRIVATE_KEY` in `.env` for deployment.

# Rh Stock Oracle

[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![Chains](https://img.shields.io/badge/Chains-RH%20%7C%20BSC%20%7C%20EVM-lightgrey)](configs/)

**Trustless pricing for tokenized equity**

TWAP/median price oracle for stock tokens on Robinhood Chain and EVM: multi-source feeds, deviation guards, on-chain push + off-chain pull modes.

## Quick start

```bash
git clone https://github.com/cervemone/rh-stock-oracle.git
cd rh-stock-oracle
pip install -r requirements.txt
python -m src.main --help
```

## Layout

```
  contracts/
  feeds/
  aggregation/
  scripts/
  test/
  deployments/
  docs/
  configs/
  examples/
  audits/
  utils/
  benchmarks/
```

## Related

- `stock-token-index` — registry of tokenized equities
- `stock-analyst-agent` — the agent that consumes this repo
- `rh-stock-token-sdk` — SDK for Robinhood Chain stock tokens

## License

MIT

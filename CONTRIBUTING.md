# Contributing

Thanks for your interest in improving this project. Contributions are welcome in the form of bug reports, documentation improvements, and pull requests.

## How to contribute

1. Fork the repo and create a feature branch.
2. Make your changes and add/adjust tests where applicable.
3. Open a pull request and describe:
   - what changed,
   - why it changed,
   - how you validated it (tests/commands).

## Development & tests

This repo contains multiple packages. Common checks include:

- `packages/goo-core`: Vitest unit tests via `npm run test:unit`
- `app`: TypeScript checks via `npm run typecheck`

If your change touches on-chain behavior, also update relevant docs and contract interfaces.

## Security

If you discover a security issue, please avoid opening a public PR. Instead, open a discreet issue or follow your project’s preferred reporting path.

## Code of Conduct

This project follows the `CODE_OF_CONDUCT.md` guidelines. By participating, you agree to uphold them.


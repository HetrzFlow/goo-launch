.PHONY: opus help

# D1 database names
D1_TESTNET := goo-server
D1_MAINNET := goo-server-mainnet

# ─── Development ───

app-dev: app-build ## Start testnet dev (wrangler + vite)
	cd app && bun run dev

app-dev-frontend: ## Start frontend dev only
	cd app/frontend && bun run dev

app-dev-worker: ## Start worker dev only
	cd app && bun run dev:worker

# ─── Build & Typecheck ───

app-build: ## Build frontend
	cd app/frontend && bun run build

app-typecheck: ## Typecheck worker
	cd app && bunx tsc --noEmit

typecheck: app-typecheck

# ─── Deploy: Testnet ───

deploy-testnet: app-build ## Deploy worker to testnet
	cd app && bunx wrangler deploy

db-migrate-testnet: ## Run D1 migrations on testnet (remote)
	cd app && bunx wrangler d1 migrations apply $(D1_TESTNET) --remote

db-migrate-testnet-local: ## Run D1 migrations on testnet (local)
	cd app && bunx wrangler d1 migrations apply $(D1_TESTNET) --local

secrets-testnet: ## Set secrets for testnet (interactive)
	cd app && bunx wrangler secret put JWT_SECRET
	cd app && bunx wrangler secret put LLM_API_KEY

tail-testnet: ## Tail testnet worker logs
	cd app && bunx wrangler tail

# ─── Deploy: Mainnet ───

deploy-mainnet: app-build ## Deploy worker to mainnet
	cd app && bunx wrangler deploy --env mainnet

db-migrate-mainnet: ## Run D1 migrations on mainnet (remote)
	cd app && bunx wrangler d1 migrations apply $(D1_MAINNET) --remote --env mainnet

secrets-mainnet: ## Set secrets for mainnet (interactive)
	cd app && bunx wrangler secret put JWT_SECRET --env mainnet
	cd app && bunx wrangler secret put LLM_API_KEY --env mainnet

tail-mainnet: ## Tail mainnet worker logs
	cd app && bunx wrangler tail --env mainnet

# ─── Deploy: Both ───

deploy-all: app-build ## Deploy to both testnet and mainnet
	cd app && bunx wrangler deploy
	cd app && bunx wrangler deploy --env mainnet

db-migrate-all: ## Run D1 migrations on both environments
	cd app && bunx wrangler d1 migrations apply $(D1_TESTNET) --remote
	cd app && bunx wrangler d1 migrations apply $(D1_MAINNET) --remote --env mainnet

# ─── Contracts ───

compile: ## Compile Solidity contracts
	cd contracts && bun install && bunx hardhat compile

test-contracts: ## Run Hardhat tests
	cd contracts && bunx hardhat test

deploy-infra-testnet: ## Deploy infra to BSC testnet (needs DEPLOYER_PRIVATE_KEY)
	@if [ -z "$$DEPLOYER_PRIVATE_KEY" ]; then echo "Usage: DEPLOYER_PRIVATE_KEY=0x... make deploy-infra-testnet"; exit 1; fi
	cd contracts && bunx hardhat run scripts/deploy-infra.ts --network bscTestnet

deploy-infra-mainnet: ## Deploy infra to BSC mainnet (needs DEPLOYER_PRIVATE_KEY)
	@if [ -z "$$DEPLOYER_PRIVATE_KEY" ]; then echo "Usage: DEPLOYER_PRIVATE_KEY=0x... make deploy-infra-mainnet"; exit 1; fi
	cd contracts && bunx hardhat run scripts/deploy-infra.ts --network bsc

# ─── Database ───

db-generate: ## Generate new D1 migration from schema changes
	cd app && bunx drizzle-kit generate

# ─── Docker (OpenClaw + goo-core) ───

DOCKER_COMPOSE := DOCKER_API_VERSION=1.43 docker compose -f deploy/docker/docker-compose.yml

docker-build: ## Build image from source and start container
	bash scripts/docker-build.sh

docker-push: ## Push built image to registry
	bash scripts/docker-push.sh

docker-run: ## Pull image from registry and start container
	bash scripts/docker-run.sh

docker-up: ## Start container (no pull)
	$(DOCKER_COMPOSE) up -d

docker-down: ## Stop agent container
	$(DOCKER_COMPOSE) down

docker-logs: ## Tail agent container logs
	$(DOCKER_COMPOSE) logs -f

# ─── Misc ───

opus: ## Start Claude Opus session
	claude --model claude-opus-4-6

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-28s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help

# AGOS Platform API Reference

This document standardizes AGOS API usage for this repository and provides:

- clear endpoint annotations (auth, params, behavior, notes)
- request/response examples
- runnable cURL examples for every endpoint

## Overview

### Base URLs

| Service | URL | Purpose |
|---|---|---|
| API | `https://claw-api.agos.fun` | Auth, agents, funding, wallets, billing, deployments |
| LLM Gateway | `https://claw-api.agos.fun/v1` | OpenAI-compatible model and chat APIs |

### Authentication

| Type | Header | Used For |
|---|---|---|
| JWT | `Authorization: Bearer <accessToken>` | User operations |
| Agent API Key | `Authorization: Bearer <apiKey>` | `/v1/chat/completions` |

### Response Conventions

Success:

```json
{ "ok": true, "data": { } }
```

Error:

```json
{ "ok": false, "error": "message" }
```

Common HTTP status:

`200` `201` `202` `400` `401` `402` `403` `404` `409` `410` `500` `502`

---

## 1) Authentication

### POST `/auth/challenge`

**Description:** Create SIWE challenge message and nonce.  
**Auth:** None

**Body**

```json
{ "address": "0xYourWalletAddress", "chainId": 56 }
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/auth/challenge \
  -H "Content-Type: application/json" \
  -d '{"address":"0xYourWalletAddress","chainId":56}'
```

### POST `/auth/verify`

**Description:** Verify SIWE signature and issue access/refresh tokens.  
**Auth:** None

**Body**

```json
{ "message": "SIWE message", "signature": "0x..." }
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"message":"...","signature":"0x..."}'
```

### POST `/auth/refresh`

**Description:** Exchange refresh token for a new access token.  
**Auth:** None

**Body**

```json
{ "refreshToken": "eyJ..." }
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJ..."}'
```

### DELETE `/auth/session`

**Description:** Logout and revoke session refresh token.  
**Auth:** None

**Body (optional)**

```json
{ "refreshToken": "eyJ..." }
```

**cURL**

```bash
curl -X DELETE https://claw-api.agos.fun/auth/session \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJ..."}'
```

---

## 2) Agents

### GET `/agents/config`

**Description:** Read minimum balance, setup fee, and first-funding threshold.  
**Auth:** None (public)

**cURL**

```bash
curl https://claw-api.agos.fun/agents/config
```

### POST `/agents`

**Description:** Create an agent. Returns one-time `apiKey`.  
**Auth:** JWT

**Body**

```json
{
  "name": "my-agent",
  "templateId": "openclaw-v1",
  "image": "ghcr.io/org/image:latest",
  "resourceClass": "vc2-1c-1gb",
  "envVars": { "KEY": "value" }
}
```

**Notes**

- provide either `templateId` or `image`
- save `apiKey` immediately; it is not returned again

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","templateId":"openclaw-v1"}'
```

### GET `/agents`

**Description:** List user-owned agents (excluding deleted).  
**Auth:** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/agents \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/agents/:id`

**Description:** Get one agent, deployment info, and AIOU wallet summary.  
**Auth:** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/agents/$AGENT_ID \
  -H "Authorization: Bearer $TOKEN"
```

### PATCH `/agents/:id/status`

**Description:** Update lifecycle state.  
**Auth:** JWT

**Body**

```json
{ "status": "active" }
```

**Allowed values:** `active`, `stopped`, `deleted`

**cURL**

```bash
curl -X PATCH https://claw-api.agos.fun/agents/$AGENT_ID/status \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"stopped"}'
```

### POST `/agents/:id/redeploy`

**Description:** Rebuild and redeploy an existing agent.  
**Auth:** JWT

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/redeploy \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### GET `/agents/:id/wallet/balance`

**Description:** Get agent AIOU balance (`availableBalance`, `frozenBalance`, `spentTotal`).  
**Auth:** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/agents/$AGENT_ID/wallet/balance \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/agents/:id/wallet/transfers`

**Description:** List transfer records for agent wallet.  
**Auth:** JWT  
**Query:** `page` (default `1`), `limit` (default `20`, max `100`)

**cURL**

```bash
curl "https://claw-api.agos.fun/agents/$AGENT_ID/wallet/transfers?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/agents/:id/fund`

**Description:** Create x402 funding challenge (HTTP 402 payload).  
**Auth:** JWT

**Body**

```json
{ "amount": "50" }
```

**Notes**

- first funding from `pending_fund` must satisfy `minInitialFundAiou`

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/fund \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":"50"}'
```

### POST `/agents/:id/fund/settle`

**Description:** Submit signed x402 payload to settle on-chain transfer.  
**Auth:** JWT

**Body**

```json
{
  "payload": {
    "authorization": { "from": "0x...", "to": "0x...", "value": "50000000000000000000", "chainId": 56 },
    "signature": "0x..."
  }
}
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/fund/settle \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payload":{"authorization":{"from":"0x...","to":"0x...","value":"50000000000000000000","chainId":56},"signature":"0x..."}}'
```

### GET `/agents/:id/settlements`

**Description:** List funding settlement history.  
**Auth:** JWT  
**Query:** `page`, `limit`

**cURL**

```bash
curl "https://claw-api.agos.fun/agents/$AGENT_ID/settlements?page=1&limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 3) Deposits (USDT On-Chain)

### POST `/payments/deposits`

**Description:** Start USDT deposit and receive x402 challenge metadata.  
**Auth:** JWT

**Body**

```json
{ "amount": "10.00", "idempotencyKey": "deposit-001" }
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/payments/deposits \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":"10.00","idempotencyKey":"deposit-001"}'
```

### GET `/payments/deposits`

**Description:** List user deposit orders.  
**Auth:** JWT  
**Query:** `page`, `limit`, optional `status=pending|confirmed|failed`

**cURL**

```bash
curl "https://claw-api.agos.fun/payments/deposits?page=1&limit=20&status=confirmed" \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/payments/deposits/:id`

**Description:** Get one deposit order detail.  
**Auth:** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/payments/deposits/$ORDER_ID \
  -H "Authorization: Bearer $TOKEN"
```

---

## 4) Wallets

### GET `/wallets/aiou/balance`

**Description:** Get user AIOU balance summary.  
**Auth:** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/wallets/aiou/balance \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/wallets/agents/:agentId/balance`

**Description:** Get target agent AIOU balance summary.  
**Auth:** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/wallets/agents/$AGENT_ID/balance \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/wallets/agents/:agentId/topup`

**Description:** Transfer AIOU from user account to agent account.  
**Auth:** JWT

**Body**

```json
{ "amount": "50.00", "idempotencyKey": "topup-001" }
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/wallets/agents/$AGENT_ID/topup \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":"50.00","idempotencyKey":"topup-001"}'
```

### POST `/wallets/agents/:agentId/reset`

**Description:** Top up only the delta required to reach `targetBalance`.  
**Auth:** JWT

**Body**

```json
{ "targetBalance": "100.00", "idempotencyKey": "reset-001" }
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/wallets/agents/$AGENT_ID/reset \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetBalance":"100.00","idempotencyKey":"reset-001"}'
```

---

## 5) Billing

### GET `/billing/snapshots`

**Description:** List daily billing snapshots.  
**Auth:** JWT  
**Query:** `agentId` (optional), `from`, `to`, `page`, `limit`

**cURL**

```bash
curl "https://claw-api.agos.fun/billing/snapshots?from=2025-01-01&to=2025-01-31&page=1&limit=30" \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/billing/usage`

**Description:** List detailed LLM token usage and cost records.  
**Auth:** JWT  
**Query:** `agentId` (optional), `from`, `to`, `page`, `limit`

**cURL**

```bash
curl "https://claw-api.agos.fun/billing/usage?from=2025-01-01&to=2025-01-31&page=1&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 6) Ledger

### GET `/ledger/entries`

**Description:** Query ledger transaction history.  
**Auth:** JWT  
**Query:** `eventType` (optional), `from`, `to`, `page`, `limit`

**Known `eventType` values**

`OnChainFunding`, `Deposit`, `AiouFrozen`, `AiouCaptured`, `AiouReleased`, `AiouTransferOut`, `AiouTransferIn`, `SetupFee`, `VpsBilling`

**cURL**

```bash
curl "https://claw-api.agos.fun/ledger/entries?eventType=OnChainFunding&page=1&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 7) Deployments

### POST `/deployments`

**Description:** Create deployment request for an agent.  
**Auth:** JWT

**Body**

```json
{ "agentId": "uuid", "spec": { "region": "ewr" } }
```

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/deployments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"'$AGENT_ID'","spec":{"region":"ewr"}}'
```

### GET `/deployments/:id`

**Description:** Get deployment detail and runtime status.  
**Auth:** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/deployments/$DEPLOYMENT_ID \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/deployments/:id/retry`

**Description:** Retry failed deployment pipeline.  
**Auth:** JWT

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/deployments/$DEPLOYMENT_ID/retry \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## 8) Templates

### GET `/templates`

**Description:** List available templates and required environment variables.  
**Auth:** None (public)

**cURL**

```bash
curl https://claw-api.agos.fun/templates
```

---

## 9) LLM API (OpenAI-Compatible)

These endpoints are hosted on `https://claw-api.agos.fun/v1`.

### GET `/v1/models`

**Description:** List models and pricing metadata.  
**Auth:** None (public)

**cURL**

```bash
curl https://claw-api.agos.fun/v1/models
```

### POST `/v1/chat/completions`

**Description:** OpenAI-compatible chat completion endpoint.  
**Auth:** Agent API Key (`Bearer <apiKey>`)

**Body**

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": false,
  "max_tokens": 1024,
  "temperature": 0.7
}
```

**cURL (non-stream)**

```bash
curl -X POST https://claw-api.agos.fun/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello!"}]}'
```

**cURL (stream)**

```bash
curl -N -X POST https://claw-api.agos.fun/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Say hi in 5 words."}]}'
```

**Billing Notes**

- estimated cost is frozen first
- actual cost is captured after provider response
- unused part is released

---

## 10) Minimal End-to-End Example

```bash
# 1) challenge
curl -X POST https://claw-api.agos.fun/auth/challenge \
  -H "Content-Type: application/json" \
  -d '{"address":"0xYourWallet","chainId":56}'

# 2) verify (after wallet signing), extract TOKEN
curl -X POST https://claw-api.agos.fun/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"message":"...","signature":"0x..."}'

# 3) create agent, extract AGENT_ID + API_KEY
curl -X POST https://claw-api.agos.fun/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-openclaw","templateId":"openclaw-v1"}'

# 4) request fund challenge
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/fund \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":"49"}'

# 5) settle x402 signed payload
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/fund/settle \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payload":{...}}'

# 6) poll status
curl https://claw-api.agos.fun/agents/$AGENT_ID \
  -H "Authorization: Bearer $TOKEN"

# 7) call LLM with API_KEY
curl -X POST https://claw-api.agos.fun/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello!"}]}'
```


# AGOS 平台 API 参考

本文档用于在本仓库内统一 AGOS API 的使用方式，并提供：

- 清晰的端点注释（认证、参数、行为说明、备注）
- 请求/响应示例
- 每个端点都可运行的 cURL 示例

---

## 概览（Overview）

### Base URLs

| 服务 | URL | 用途 |
|---|---|---|
| API | `https://claw-api.agos.fun` | 认证、代理、资金、钱包、计费、部署等 |
| LLM Gateway | `https://claw-api.agos.fun/v1` | OpenAI 兼容的模型与聊天 API |

### Authentication

| 类型 | Header | 用于 |
|---|---|---|
| JWT | `Authorization: Bearer <accessToken>` | 用户操作 |
| 代理 API Key | `Authorization: Bearer <apiKey>` | `/v1/chat/completions` |

### Response Conventions

成功（Success）：

```json
{ "ok": true, "data": { } }
```

错误（Error）：

```json
{ "ok": false, "error": "message" }
```

常见 HTTP 状态码：

`200` `201` `202` `400` `401` `402` `403` `404` `409` `410` `500` `502`

---

## 1) 认证（Authentication）

### POST `/auth/challenge`

**描述：** 创建 SIWE challenge message 与 nonce。  
**鉴权：** 无

请求体（Body）：

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

**描述：** 校验 SIWE 签名并签发访问/刷新令牌。  
**鉴权：** 无

请求体（Body）：

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

**描述：** 用 refresh token 换取新的 access token。  
**鉴权：** 无

请求体（Body）：

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

**描述：** 退出并吊销会话 refresh token。  
**鉴权：** 无

请求体（可选）（Body (optional)）：

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

## 2) 代理（Agents）

### GET `/agents/config`

**描述：** 读取最低余额、设置费用，以及首次充值门槛。  
**鉴权：** 无（public）

**cURL**

```bash
curl https://claw-api.agos.fun/agents/config
```

### POST `/agents`

**描述：** 创建代理。返回一次性 `apiKey`。  
**鉴权：** JWT

请求体（Body）：

```json
{
  "name": "my-agent",
  "templateId": "openclaw-v1",
  "image": "ghcr.io/org/image:latest",
  "resourceClass": "vc2-1c-1gb",
  "envVars": { "KEY": "value" }
}
```

**备注（Notes）**

- 提供 `templateId` 或 `image` 二选一即可
- 立刻保存 `apiKey`；之后不会再返回

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-agent","templateId":"openclaw-v1"}'
```

### GET `/agents`

**描述：** 列出用户拥有的代理（不包括已删除）。  
**鉴权：** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/agents \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/agents/:id`

**描述：** 获取单个代理、部署信息，以及 AIOU 钱包摘要。  
**鉴权：** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/agents/$AGENT_ID \
  -H "Authorization: Bearer $TOKEN"
```

### PATCH `/agents/:id/status`

**描述：** 更新生命周期状态。  
**鉴权：** JWT

请求体（Body）：

```json
{ "status": "active" }
```

**允许值（Allowed values）：** `active`、`stopped`、`deleted`

**cURL**

```bash
curl -X PATCH https://claw-api.agos.fun/agents/$AGENT_ID/status \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"stopped"}'
```

### POST `/agents/:id/redeploy`

**描述：** 重建并重新部署一个已存在的代理。  
**鉴权：** JWT

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/redeploy \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### GET `/agents/:id/wallet/balance`

**描述：** 获取代理 AIOU 余额（`availableBalance`、`frozenBalance`、`spentTotal`）。  
**鉴权：** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/agents/$AGENT_ID/wallet/balance \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/agents/:id/wallet/transfers`

**描述：** 列出代理钱包的转账记录。  
**鉴权：** JWT  
**查询参数（Query）：** `page`（默认 `1`）、`limit`（默认 `20`，最大 `100`）

**cURL**

```bash
curl "https://claw-api.agos.fun/agents/$AGENT_ID/wallet/transfers?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/agents/:id/fund`

**描述：** 创建 x402 资金挑战（HTTP 402 payload）。  
**鉴权：** JWT

请求体（Body）：

```json
{ "amount": "50" }
```

**备注（Notes）**

- 首次资金（来自 `pending_fund`）必须满足 `minInitialFundAiou`

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/fund \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":"50"}'
```

### POST `/agents/:id/fund/settle`

**描述：** 提交签名后的 x402 payload，用于链上转账结算。  
**鉴权：** JWT

请求体（Body）：

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

**描述：** 列出资金结算历史。  
**鉴权：** JWT  
**查询参数（Query）：** `page`、`limit`

**cURL**

```bash
curl "https://claw-api.agos.fun/agents/$AGENT_ID/settlements?page=1&limit=10" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 3) 存款（USDT 链上）

### POST `/payments/deposits`

**描述：** 开始 USDT 存款，并接收 x402 挑战元数据。  
**鉴权：** JWT

请求体（Body）：

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

**描述：** 列出用户存款订单。  
**鉴权：** JWT  
**查询参数（Query）：** `page`、`limit`，以及可选 `status=pending|confirmed|failed`

**cURL**

```bash
curl "https://claw-api.agos.fun/payments/deposits?page=1&limit=20&status=confirmed" \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/payments/deposits/:id`

**描述：** 获取单个存款订单详情。  
**鉴权：** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/payments/deposits/$ORDER_ID \
  -H "Authorization: Bearer $TOKEN"
```

---

## 4) 钱包（Wallets）

### GET `/wallets/aiou/balance`

**描述：** 获取用户 AIOU 余额汇总。  
**鉴权：** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/wallets/aiou/balance \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/wallets/agents/:agentId/balance`

**描述：** 获取目标代理的 AIOU 余额汇总。  
**鉴权：** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/wallets/agents/$AGENT_ID/balance \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/wallets/agents/:agentId/topup`

**描述：** 把 AIOU 从用户账户转到代理账户。  
**鉴权：** JWT

请求体（Body）：

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

**描述：** 仅补足差额，把余额增加到 `targetBalance`。  
**鉴权：** JWT

请求体（Body）：

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

## 5) 计费（Billing）

### GET `/billing/snapshots`

**描述：** 列出每日计费快照。  
**鉴权：** JWT  
**查询参数（Query）：** `agentId`（可选）、`from`、`to`、`page`、`limit`

**cURL**

```bash
curl "https://claw-api.agos.fun/billing/snapshots?from=2025-01-01&to=2025-01-31&page=1&limit=30" \
  -H "Authorization: Bearer $TOKEN"
```

### GET `/billing/usage`

**描述：** 列出详细的 LLM token 使用量与成本记录。  
**鉴权：** JWT  
**查询参数（Query）：** `agentId`（可选）、`from`、`to`、`page`、`limit`

**cURL**

```bash
curl "https://claw-api.agos.fun/billing/usage?from=2025-01-01&to=2025-01-31&page=1&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 6) 分类账（Ledger）

### GET `/ledger/entries`

**描述：** 查询分类账交易历史。  
**鉴权：** JWT  
**查询参数（Query）：** `eventType`（可选）、`from`、`to`、`page`、`limit`

已知的 `eventType` 值：

`OnChainFunding`, `Deposit`, `AiouFrozen`, `AiouCaptured`, `AiouReleased`, `AiouTransferOut`, `AiouTransferIn`, `SetupFee`, `VpsBilling`

**cURL**

```bash
curl "https://claw-api.agos.fun/ledger/entries?eventType=OnChainFunding&page=1&limit=50" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 7) 部署（Deployments）

### POST `/deployments`

**描述：** 为代理创建部署请求。  
**鉴权：** JWT

请求体（Body）：

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

**描述：** 获取部署详情与运行时状态。  
**鉴权：** JWT

**cURL**

```bash
curl https://claw-api.agos.fun/deployments/$DEPLOYMENT_ID \
  -H "Authorization: Bearer $TOKEN"
```

### POST `/deployments/:id/retry`

**描述：** 重试失败的部署流水线。  
**鉴权：** JWT

**cURL**

```bash
curl -X POST https://claw-api.agos.fun/deployments/$DEPLOYMENT_ID/retry \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## 8) 模板（Templates）

### GET `/templates`

**描述：** 列出可用模板及所需环境变量。  
**鉴权：** 无（public）

**cURL**

```bash
curl https://claw-api.agos.fun/templates
```

---

## 9) LLM API（OpenAI 兼容）

这些端点托管在 `https://claw-api.agos.fun/v1`。

### GET `/v1/models`

**描述：** 列出模型与定价元数据。  
**鉴权：** 无（public）

**cURL**

```bash
curl https://claw-api.agos.fun/v1/models
```

### POST `/v1/chat/completions`

**描述：** OpenAI 兼容的聊天补全接口。  
**鉴权：** 代理 API Key（`Bearer <apiKey>`）

请求体（Body）：

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

**cURL（非流式）**

```bash
curl -X POST https://claw-api.agos.fun/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello!"}]}'
```

**cURL（流式）**

```bash
curl -N -X POST https://claw-api.agos.fun/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Say hi in 5 words."}]}'
```

**计费备注（Billing Notes）**

- 预计成本会先冻结（estimated cost is frozen first）
- 实际成本在提供方返回后被记录（actual cost is captured after provider response）
- 未使用部分会释放（unused part is released）

---

## 10) 最小端到端示例（Minimal End-to-End Example）

```bash
# 1) challenge
curl -X POST https://claw-api.agos.fun/auth/challenge \
  -H "Content-Type: application/json" \
  -d '{"address":"0xYourWallet","chainId":56}'

# 2) verify（钱包签名后，提取 TOKEN）
curl -X POST https://claw-api.agos.fun/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"message":"...","signature":"0x..."}'

# 3) 创建代理，提取 AGENT_ID + API_KEY
curl -X POST https://claw-api.agos.fun/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-openclaw","templateId":"openclaw-v1"}'

# 4) 请求资金挑战
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/fund \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":"49"}'

# 5) 结算 x402 已签名 payload
curl -X POST https://claw-api.agos.fun/agents/$AGENT_ID/fund/settle \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"payload":{...}}'

# 6) 轮询状态
curl https://claw-api.agos.fun/agents/$AGENT_ID \
  -H "Authorization: Bearer $TOKEN"

# 7) 使用 API_KEY 调用 LLM
curl -X POST https://claw-api.agos.fun/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello!"}]}'
```


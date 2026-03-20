/**
 * AGOS Finance Layer (worker)
 *
 * Higher-level finance semantics built on top of agos-client:
 * - Session restoration from stored encrypted tokens
 * - x402 funding challenge / settlement
 * - Balance queries in a finance-oriented shape
 * - Agent topup with idempotency
 */

import { decryptPrivateKey } from '../crypto';
import {
  AgosClient,
  createAgosClient,
  type AgosFundChallenge,
  type AgosFundSettleResult,
} from '../agos-client';
import {
  assembleSettlePayload,
  buildTransferWithAuthorization,
  dryRunTransferWithAuthorization,
  type BuildTransferAuthOptions,
  type Eip3009DryRunResult,
  type Eip3009PreparedChallenge,
  type Eip3009SettlePayload,
  type Eip3009SettleTemplate,
} from './eip3009';

export interface FundingChallengeResult {
  needsPayment: true;
  challenge: AgosFundChallenge;
}

export interface FundingAcceptedResult {
  needsPayment: false;
}

export type StartFundingResult = FundingChallengeResult | FundingAcceptedResult;

export interface AgosFinanceSnapshot {
  availableBalance: string;
  frozenBalance: string;
  spentTotal: string;
}

export interface TopupResult {
  transferId: string;
  amount: string;
  status: string;
}

function createAuthenticatedClient(agosApiUrl: string, accessToken: string): AgosClient {
  const client = createAgosClient(agosApiUrl);
  client.setAccessToken(accessToken);
  return client;
}

async function withFundingChallenge<T>(
  client: AgosClient,
  agosAgentId: string,
  amount: string,
  onChallenge: (challenge: AgosFundChallenge) => T | Promise<T>,
): Promise<T | null> {
  const result = await startFundingChallenge(client, agosAgentId, amount);
  if (!result.needsPayment) {
    return null;
  }

  return onChallenge(result.challenge);
}

function createTopupIdempotencyKey(agenterId: string): string {
  return `topup-${agenterId}-${Date.now()}`;
}

export interface RestoredAgosSession {
  client: AgosClient;
  /** Non-null when the access token was refreshed and should be persisted. */
  refreshedAccessToken: string | null;
}

/**
 * Create an authenticated AgosClient from a stored (encrypted) access token.
 * Worker crypto is async, so this returns a Promise.
 *
 * When a refresh succeeds, `refreshedAccessToken` contains the new plaintext
 * access token so the caller can encrypt and persist it back to DB.
 */
export async function restoreAgosSession(
  encryptedAccessToken: string,
  encryptedRefreshToken: string | null | undefined,
  agosApiUrl: string,
  jwtSecret: string,
): Promise<RestoredAgosSession> {
  const accessToken = await decryptPrivateKey(encryptedAccessToken, jwtSecret);

  if (!encryptedRefreshToken) {
    return { client: createAuthenticatedClient(agosApiUrl, accessToken), refreshedAccessToken: null };
  }

  try {
    const refreshToken = await decryptPrivateKey(encryptedRefreshToken, jwtSecret);
    const refreshed = await createAgosClient(agosApiUrl).refresh(refreshToken);
    return {
      client: createAuthenticatedClient(agosApiUrl, refreshed.accessToken),
      refreshedAccessToken: refreshed.accessToken,
    };
  } catch {
    return { client: createAuthenticatedClient(agosApiUrl, accessToken), refreshedAccessToken: null };
  }
}

/**
 * Create an authenticated AgosClient from a raw (plaintext) token,
 * e.g. one passed via request header or body.
 */
export function agosClientFromToken(token: string, agosApiUrl: string): AgosClient {
  return createAuthenticatedClient(agosApiUrl, token);
}

/**
 * Initiate an x402 funding flow for an AGOS agent.
 * Returns a challenge when the platform responds with 402,
 * or signals acceptance if no payment is required.
 */
export async function startFundingChallenge(
  client: AgosClient,
  agosAgentId: string,
  amount: string,
): Promise<StartFundingResult> {
  const result = await client.fundAgent(agosAgentId, amount);
  if (result.status === 402 && result.challenge) {
    return { needsPayment: true, challenge: result.challenge };
  }

  return { needsPayment: false };
}

/**
 * Submit a signed x402 payload to settle a funding challenge.
 */
export async function settleFunding(
  client: AgosClient,
  agosAgentId: string,
  payload: unknown,
): Promise<AgosFundSettleResult> {
  return client.settleFund(agosAgentId, payload);
}

/**
 * Get the authenticated user's AIOU balance.
 */
export async function getUserBalance(client: AgosClient): Promise<AgosFinanceSnapshot> {
  return client.getUserBalance();
}

/**
 * Get an agent's AIOU balance.
 */
export async function getAgentBalance(client: AgosClient, agosAgentId: string): Promise<AgosFinanceSnapshot> {
  return client.getAgentBalance(agosAgentId);
}

/**
 * Transfer AIOU from user wallet to agent wallet.
 * Generates an idempotency key from agenterId + timestamp.
 */
export async function topupAgent(
  client: AgosClient,
  agosAgentId: string,
  agenterId: string,
  amount: string,
): Promise<TopupResult> {
  return client.topupAgent(agosAgentId, amount, createTopupIdempotencyKey(agenterId));
}

/**
 * Full flow: initiate funding -> if 402, build EIP-3009 typed data for signing.
 * Returns null if no payment is needed (already funded).
 */
export async function prepareFundingPayment(
  client: AgosClient,
  agosAgentId: string,
  amount: string,
  payerAddress: string,
  authOpts?: Omit<BuildTransferAuthOptions, 'from'>,
): Promise<Eip3009PreparedChallenge | null> {
  return withFundingChallenge(client, agosAgentId, amount, (challenge) => (
    buildTransferWithAuthorization(challenge, {
      ...authOpts,
      from: payerAddress,
    })
  ));
}

/**
 * Dry-run: initiate funding -> if 402, build EIP-3009 typed data + summary.
 * Does NOT execute any payment. Useful for preview/debug.
 */
export async function dryRunFundingPayment(
  client: AgosClient,
  agosAgentId: string,
  amount: string,
  payerAddress: string,
  authOpts?: Omit<BuildTransferAuthOptions, 'from'>,
): Promise<Eip3009DryRunResult | null> {
  return withFundingChallenge(client, agosAgentId, amount, (challenge) => (
    dryRunTransferWithAuthorization(challenge, {
      ...authOpts,
      from: payerAddress,
    })
  ));
}

/**
 * Submit a signed EIP-3009 authorization to settle funding.
 */
export async function settleWithEip3009(
  client: AgosClient,
  agosAgentId: string,
  source: Eip3009PreparedChallenge | Eip3009SettleTemplate,
  signature: string,
): Promise<AgosFundSettleResult> {
  return client.settleFund(agosAgentId, assembleSettlePayload(source, signature));
}

export { createAgosClient };
export {
  assembleSettlePayload,
  buildTransferWithAuthorization,
  dryRunTransferWithAuthorization,
  type BuildTransferAuthOptions,
  type Eip3009DryRunResult,
  type Eip3009PreparedChallenge,
  type Eip3009SettlePayload,
  type Eip3009SettleTemplate,
} from './eip3009';

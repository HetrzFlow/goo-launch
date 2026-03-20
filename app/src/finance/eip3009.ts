/**
 * EIP-3009 transferWithAuthorization helpers
 *
 * Builds EIP-712 typed data payloads from an AGOS fund challenge (402 response).
 * The caller signs this typed data off-chain, then submits the signature via settle.
 *
 * Future: receiveWithAuthorization can be added as a parallel path.
 */

import type { AgosFundChallenge } from '../agos-client';

const TRANSFER_WITH_AUTHORIZATION_TYPE = {
  name: 'TransferWithAuthorization',
  fields: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const DEFAULT_VALID_AFTER = 0;
const DEFAULT_VALIDITY_SECONDS = 30 * 60;

type AgosFundAccept = AgosFundChallenge['accepts'][number];

export interface Eip3009AuthorizationParams {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface Eip712TypedData {
  types: {
    EIP712Domain: Array<{ name: string; type: string }>;
    TransferWithAuthorization: Array<{ name: string; type: string }>;
  };
  primaryType: 'TransferWithAuthorization';
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  message: Eip3009AuthorizationParams;
}

export interface Eip3009SettlePayload {
  x402: {
    x402Version: number;
    scheme: string;
    namespace: string;
    networkId: string;
    resource: string;
    payload: {
      type: 'authorization';
      authorization: Eip3009AuthorizationParams;
      signature: string;
    };
  };
  challengeTs: number;
}

export interface Eip3009SettleTemplate {
  x402Version: number;
  scheme: string;
  namespace: string;
  networkId: string;
  resource: string;
  challengeTs: number;
  payload: {
    signature: null;
    authorization: Eip3009AuthorizationParams;
  };
}

export interface Eip3009PreparedChallenge {
  typedData: Eip712TypedData;
  settleTemplate: Eip3009SettleTemplate;
  accept: AgosFundAccept;
}

export interface BuildTransferAuthOptions {
  /** Payer wallet address (the `from` in transferWithAuthorization). */
  from: string;
  /** Override token name for EIP-712 domain (default: "AIOU Credit"). */
  tokenName?: string;
  /** Override EIP-712 domain version (default: "1"). */
  domainVersion?: string;
  /** Custom nonce (bytes32 hex). Generated randomly if not provided. */
  nonce?: string;
  /** Unix timestamp after which auth is valid (default: 0 = immediately). */
  validAfter?: number;
  /** Validity window in seconds from now (default: 1800 = 30 min). */
  validitySeconds?: number;
}

export interface Eip3009DryRunResult {
  prepared: Eip3009PreparedChallenge;
  summary: {
    tokenContract: string;
    from: string;
    to: string;
    value: string;
    chainId: number;
    nonce: string;
    validAfter: string;
    validBefore: string;
    validBeforeISO: string;
  };
}

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function requireEip3009Accept(challenge: AgosFundChallenge): AgosFundAccept {
  const accept = challenge.accepts.find(
    (entry) => entry.extra?.authorizationType === 'eip3009',
  );

  if (!accept) {
    throw new Error(
      'No eip3009 accept entry in challenge. '
      + `Available types: ${challenge.accepts.map((entry) => entry.extra?.authorizationType ?? 'unknown').join(', ')}`,
    );
  }

  return accept;
}

function buildAuthorizationWindow(opts: BuildTransferAuthOptions): Pick<Eip3009AuthorizationParams, 'validAfter' | 'validBefore'> {
  const validAfter = opts.validAfter ?? DEFAULT_VALID_AFTER;
  const validitySeconds = opts.validitySeconds ?? DEFAULT_VALIDITY_SECONDS;
  return {
    validAfter: String(validAfter),
    validBefore: String(Math.floor(Date.now() / 1000) + validitySeconds),
  };
}

function createAuthorizationParams(
  accept: AgosFundAccept,
  opts: BuildTransferAuthOptions,
): Eip3009AuthorizationParams {
  // Use nonce from challenge extra (AGOS-provided) if available, then opts, then random
  const nonce = (accept.extra?.nonce as string) ?? opts.nonce ?? generateNonce();
  return {
    from: opts.from,
    to: accept.payTo,
    value: accept.maxAmountRequired,
    nonce,
    ...buildAuthorizationWindow(opts),
  };
}

function createSettleTemplate(
  challenge: AgosFundChallenge,
  accept: AgosFundAccept,
  authorization: Eip3009AuthorizationParams,
): Eip3009SettleTemplate {
  return {
    x402Version: challenge.x402Version,
    scheme: accept.scheme,
    namespace: accept.namespace,
    networkId: accept.networkId,
    resource: accept.resource,
    challengeTs: Number(accept.extra?.challengeTs ?? 0),
    payload: {
      signature: null,
      authorization,
    },
  };
}

/**
 * Build EIP-712 typed data for `transferWithAuthorization` from an AGOS 402 challenge.
 *
 * Picks the first `authorizationType=eip3009` entry from `challenge.accepts`.
 * Throws if no matching entry is found.
 *
 * Current AGOS funding token domain (verified against on-chain DOMAIN_SEPARATOR):
 * - name: "AIOU Credit"
 * - version: "1"
 *
 * The returned `typedData` can be passed to `eth_signTypedData_v4` in a wallet,
 * and the resulting signature combined with `settleTemplate` to form the settle payload.
 */
export function buildTransferWithAuthorization(
  challenge: AgosFundChallenge,
  opts: BuildTransferAuthOptions,
): Eip3009PreparedChallenge {
  const accept = requireEip3009Accept(challenge);
  const chainId = Number(accept.extra?.chainId ?? accept.networkId);

  if (!chainId) {
    throw new Error('Cannot determine chainId from challenge accept entry');
  }

  const authorization = createAuthorizationParams(accept, opts);
  const typedData: Eip712TypedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION_TYPE.fields],
    },
    primaryType: 'TransferWithAuthorization',
    domain: {
      name: opts.tokenName ?? 'AIOU Credit',
      version: opts.domainVersion ?? '1',
      chainId,
      verifyingContract: accept.asset,
    },
    message: authorization,
  };

  return {
    typedData,
    settleTemplate: createSettleTemplate(challenge, accept, authorization),
    accept,
  };
}

/**
 * Assemble a complete settle payload from either a prepared challenge or the
 * raw settleTemplate returned by `prepare-transfer`.
 */
export function assembleSettlePayload(
  source: Eip3009PreparedChallenge | Eip3009SettleTemplate,
  signature: string,
): Eip3009SettlePayload {
  const settleTemplate = 'settleTemplate' in source ? source.settleTemplate : source;
  return {
    x402: {
      x402Version: settleTemplate.x402Version,
      scheme: settleTemplate.scheme,
      namespace: settleTemplate.namespace,
      networkId: settleTemplate.networkId,
      resource: settleTemplate.resource,
      payload: {
        type: 'authorization',
        authorization: settleTemplate.payload.authorization,
        signature,
      },
    },
    challengeTs: settleTemplate.challengeTs,
  };
}

/**
 * Prepare an EIP-3009 payment from a challenge without executing anything.
 * Returns the typed data, settle template, and a human-readable summary.
 * Useful for frontend preview / debug / logging before actual signing.
 */
export function dryRunTransferWithAuthorization(
  challenge: AgosFundChallenge,
  opts: BuildTransferAuthOptions,
): Eip3009DryRunResult {
  const prepared = buildTransferWithAuthorization(challenge, opts);
  const { domain, message } = prepared.typedData;

  return {
    prepared,
    summary: {
      tokenContract: domain.verifyingContract,
      from: message.from,
      to: message.to,
      value: message.value,
      chainId: domain.chainId,
      nonce: message.nonce,
      validAfter: message.validAfter,
      validBefore: message.validBefore,
      validBeforeISO: new Date(Number(message.validBefore) * 1000).toISOString(),
    },
  };
}

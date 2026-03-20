// Manual JWT implementation using Web Crypto HMAC-SHA256.
// Produces tokens compatible with the jsonwebtoken library.

const encoder = new TextEncoder();

function base64urlEncode(data: Uint8Array): string {
  const binStr = Array.from(data, (b) => String.fromCharCode(b)).join('');
  return btoa(binStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  // Restore padding
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const binStr = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binStr, (c) => c.charCodeAt(0));
}

export interface TokenPayload {
  user_id: number;
  wallet_address: string;
  role: string;
}

interface JwtPayload extends TokenPayload {
  iat: number;
  exp: number;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signToken(payload: TokenPayload, jwtSecret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + 86400, // 24h
  };

  const headerB64 = base64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64urlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getHmacKey(jwtSecret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const sigB64 = base64urlEncode(new Uint8Array(sig));

  return `${signingInput}.${sigB64}`;
}

export async function verifyToken(token: string, jwtSecret: string): Promise<TokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getHmacKey(jwtSecret);
  const sigBytes = base64urlDecode(sigB64);
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(signingInput));
  if (!valid) {
    throw new Error('Invalid token signature');
  }

  const payload: JwtPayload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) {
    throw new Error('Token expired');
  }

  return {
    user_id: payload.user_id,
    wallet_address: payload.wallet_address,
    role: payload.role,
  };
}

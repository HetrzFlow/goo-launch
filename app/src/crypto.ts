// Web Crypto equivalents of server/src/crypto.ts
// All functions are async. Output format is compatible with the Node.js version.

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive AES-256-GCM key from JWT secret.
 * Must match Node.js: Buffer.from(jwtSecret).subarray(0, 32).toString('hex').padEnd(64, '0')
 * then hex-decoded back to 32 bytes.
 */
async function deriveKey(jwtSecret: string): Promise<CryptoKey> {
  const raw = encoder.encode(jwtSecret);
  const first32 = raw.subarray(0, 32);
  const hexStr = bytesToHex(first32).padEnd(64, '0');
  const keyBytes = hexToBytes(hexStr);
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptPrivateKey(privateKey: string, jwtSecret: string): Promise<string> {
  const key = await deriveKey(jwtSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = encoder.encode(privateKey);
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, encoded);
  // Web Crypto appends the 16-byte auth tag to the ciphertext
  const cipherArr = new Uint8Array(cipherBuf);
  const encrypted = cipherArr.subarray(0, cipherArr.length - 16);
  const tag = cipherArr.subarray(cipherArr.length - 16);
  return bytesToHex(iv) + ':' + bytesToHex(tag) + ':' + bytesToHex(encrypted);
}

export async function decryptPrivateKey(encrypted: string, jwtSecret: string): Promise<string> {
  const [ivHex, tagHex, dataHex] = encrypted.split(':');
  const key = await deriveKey(jwtSecret);
  const iv = hexToBytes(ivHex);
  const tag = hexToBytes(tagHex);
  const data = hexToBytes(dataHex);
  // Web Crypto expects ciphertext + tag concatenated
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, combined);
  return new TextDecoder().decode(plainBuf);
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export async function generateRuntimeToken(
  agenterId: string,
  jwtSecret: string,
): Promise<string> {
  return hmacSha256(`${jwtSecret}:agent-runtime`, agenterId);
}

export async function verifyRuntimeToken(
  agenterId: string,
  token: string,
  jwtSecret: string,
): Promise<boolean> {
  // Check current salt first, then legacy salts for backward compatibility
  const current = await hmacSha256(`${jwtSecret}:agent-runtime`, agenterId);
  if (current === token) return true;
  const legacyAgos = await hmacSha256(`${jwtSecret}:agos-runtime`, agenterId);
  if (legacyAgos === token) return true;
  const legacyByod = await hmacSha256(jwtSecret, agenterId);
  return legacyByod === token;
}

/** @deprecated Use generateRuntimeToken */
export const generateAgosRuntimeToken = generateRuntimeToken;
/** @deprecated Use generateRuntimeToken */
export const generateByodToken = generateRuntimeToken;

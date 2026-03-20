const NONCE_TTL_SECONDS = 300; // 5 minutes

export async function storeNonce(kv: KVNamespace, wallet: string, nonce: string): Promise<void> {
  await kv.put(`nonce:${wallet}`, nonce, { expirationTtl: NONCE_TTL_SECONDS });
}

export async function getNonce(kv: KVNamespace, wallet: string): Promise<string | null> {
  return kv.get(`nonce:${wallet}`);
}

export async function consumeNonce(kv: KVNamespace, wallet: string): Promise<void> {
  await kv.delete(`nonce:${wallet}`);
}

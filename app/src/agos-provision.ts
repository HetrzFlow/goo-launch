/**
 * AGOS VPS provisioning — builds Docker setup scripts for blank VPS instances.
 *
 * AGOS provisions a blank VPS (Docker pre-installed, SSH access via IP + password)
 * but does NOT deploy our Docker image or configure env vars. This module generates
 * the setup script and provides verification helpers.
 */

const DEFAULT_GATEWAY_PORT = '18789';

export interface ProvisionConfig {
  publicIp: string;
  password: string;
  dockerImage: string;
  envVars: Record<string, string>;
  gatewayPort?: string;
  /** AGOS subdomain endpoint (e.g. https://uuid.agent.agos.fun) — used as gatewayUrl instead of ws://IP:port */
  agosEndpoint?: string;
}

export interface ProvisionResult {
  script: string;
  sshCommand: string;
  gatewayUrl: string;
  gatewayPort: string;
  healthcheckUrl: string;
  publicIp: string;
}

/**
 * Build the Docker provisioning script for a blank AGOS VPS.
 * The script pulls the Docker image and starts the container with all env vars.
 */
export function buildProvisionScript(config: ProvisionConfig): ProvisionResult {
  const gwPort = config.gatewayPort || DEFAULT_GATEWAY_PORT;
  // Prefer AGOS subdomain endpoint (HTTPS, nginx proxies port 80 → gateway)
  const gatewayUrl = config.agosEndpoint || `ws://${config.publicIp}:${gwPort}`;
  const healthcheckUrl = config.agosEndpoint
    ? `${config.agosEndpoint}/control/healthz`
    : `http://${config.publicIp}:${gwPort}/control/healthz`;

  const envFlags = Object.entries(config.envVars)
    .map(([k, v]) => `  -e ${k}=${JSON.stringify(v)}`)
    .join(' \\\n');

  const script = `#!/bin/bash
set -e

echo "=== Goo Agent VPS Setup ==="
echo "VPS: ${config.publicIp}"

# 1. Install Docker if not present
if ! command -v docker &>/dev/null; then
  echo "[setup] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "[setup] Docker already installed"
fi

# 2. Pull image
echo "[GOO:PULLING]"
echo "[setup] Pulling ${config.dockerImage}..."
docker pull ${config.dockerImage}

# 3. Stop ALL existing containers (including AGOS default) to free ports
docker rm -f goo-agent agosclaw-agent 2>/dev/null || true

# 3.5. Open ports in firewall (if ufw is active)
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  echo "[setup] Opening port ${gwPort} in firewall..."
  ufw allow ${gwPort}/tcp >/dev/null 2>&1 || true
fi

# 3.6. Reconfigure host nginx to proxy to ${gwPort} (AGOS default is 80 → 8080)
if [ -f /etc/nginx/sites-enabled/default ] || [ -d /etc/nginx/conf.d ]; then
  echo "[setup] Reconfiguring host nginx (80 → ${gwPort})..."
  sed -i 's|proxy_pass http://127.0.0.1:8080|proxy_pass http://127.0.0.1:${gwPort}|g' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/* 2>/dev/null || true
  nginx -t && systemctl reload nginx || true
fi

# 4. Run container
echo "[GOO:STARTING]"
echo "[setup] Starting container on port ${gwPort}..."
docker run -d \\
  --name goo-agent \\
  --restart unless-stopped \\
  --network host \\
${envFlags} \\
  -e GATEWAY_PORT=${gwPort} \\
  ${config.dockerImage}

echo "[GOO:DONE]"
echo ""
echo "=== Setup complete ==="
echo "Container: $(docker ps --filter name=goo-agent --format '{{.ID}} {{.Status}}')"
echo "Gateway: ${gatewayUrl}"
echo ""
echo "Useful commands:"
echo "  docker logs -f goo-agent"
echo "  curl ${healthcheckUrl}"
`;

  const sshCommand = `sshpass -p '${config.password}' ssh -o StrictHostKeyChecking=no root@${config.publicIp}`;

  return {
    script,
    sshCommand,
    gatewayUrl,
    gatewayPort: gwPort,
    healthcheckUrl,
    publicIp: config.publicIp,
  };
}

/**
 * Check if the control-server healthcheck is responding on the VPS.
 */
export async function checkProvisionHealth(
  publicIp: string,
  port: string = DEFAULT_GATEWAY_PORT,
  timeoutMs: number = 5000,
  gatewayToken?: string,
): Promise<{ ok: boolean; error?: string }> {
  const headers: Record<string, string> = {};
  if (gatewayToken) {
    headers['Authorization'] = `Bearer ${gatewayToken}`;
  }

  // Try authenticated /control/healthz first, fall back to unauthenticated /healthz
  const paths = ['/control/healthz', '/healthz'];
  for (const path of paths) {
    const url = `http://${publicIp}:${port}${path}`;
    try {
      const res = await fetch(url, {
        headers: path.startsWith('/control') ? headers : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        return { ok: true };
      }
      // If /control/healthz returns 403, try next path
      if (res.status === 403 && path === '/control/healthz') continue;
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      // Timeout or connection refused — container probably not running
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: false, error: 'All health check paths failed' };
}

/**
 * Check health via AGOS subdomain endpoint (nginx reverse proxy on port 80).
 */
export async function checkEndpointHealth(
  endpoint: string,
  timeoutMs: number = 5000,
): Promise<{ ok: boolean; error?: string }> {
  const base = endpoint.replace(/\/+$/, '');
  for (const path of ['/control/healthz', '/healthz']) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true };
      if (res.status === 403 && path === '/control/healthz') continue;
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return { ok: false, error: 'All health check paths failed' };
}

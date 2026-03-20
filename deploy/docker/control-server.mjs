import { createServer, request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// --- Config ---
// control-server sits in front of the OpenClaw gateway on the public port.
// - /control/* paths are handled directly (require AGENT_RUNTIME_TOKEN auth)
// - Everything else (HTTP + WebSocket) is reverse-proxied to the gateway on GATEWAY_INTERNAL_PORT

const PORT = Number(process.env.CONTROL_PORT || "18789");
const GATEWAY_INTERNAL_PORT = Number(process.env.GATEWAY_INTERNAL_PORT || "19791");
const DATA_DIR = process.env.DATA_DIR || "/root/.goo-core/data";
const AGENT_RUNTIME_TOKEN = process.env.AGENT_RUNTIME_TOKEN || "";
const GOO_CORE_ENV = process.env.GOO_CORE_ENV || "/root/.goo-core/.env";
const LOG_DIR = "/var/log/sandbox";

const MAX_OUTPUT = 512_000; // 512KB
const DEFAULT_TIMEOUT = 60_000; // 60s

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 256_000) {
      throw new Error("Request body too large");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params = {};
  for (const pair of url.slice(idx + 1).split("&")) {
    const [k, v] = pair.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return params;
}

async function writeCreatorFile(filename, content) {
  const path = join(DATA_DIR, filename);
  const normalized = typeof content === "string" ? content : "";
  if (normalized.trim().length === 0) {
    await rm(path, { force: true });
    return `removed:${filename}`;
  }
  await writeFile(path, normalized, "utf-8");
  return filename;
}

function execCommand(command, timeoutMs) {
  const timeout = Math.min(timeoutMs || DEFAULT_TIMEOUT, DEFAULT_TIMEOUT);
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-c", command], {
      timeout,
      maxBuffer: MAX_OUTPUT,
      env: process.env,
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        exitCode: error ? (error.code ?? 1) : 0,
      });
    });
  });
}

function checkAuth(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return !!(AGENT_RUNTIME_TOKEN && token === AGENT_RUNTIME_TOKEN);
}

// ---------- /control/* handlers ----------

async function handleExec(req, res) {
  const body = await readJson(req);
  if (!body.command || typeof body.command !== "string") {
    return sendJson(res, 400, { error: "command is required" });
  }
  const result = await execCommand(body.command, body.timeoutMs);
  sendJson(res, 200, result);
}

async function handleStatus(_req, res) {
  const [disk, memory, uptime, containers] = await Promise.all([
    execCommand("df -h / | tail -1", 5000),
    execCommand("free -m | head -3", 5000),
    execCommand("uptime -p 2>/dev/null || uptime", 5000),
    execCommand("docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null || echo 'docker not available'", 5000),
  ]);

  // Check for goo-core process: it runs as a node process (npm global @devbond/gc),
  // so pidof goo-core won't work. Check /proc cmdlines or curl its liveness endpoint.
  const gooCoreCheck = await execCommand("grep -rl 'goo-core' /proc/[0-9]*/cmdline >/dev/null 2>&1 && echo running || echo stopped", 3000);
  const gatewayCheck = await execCommand("curl -sf http://127.0.0.1:" + GATEWAY_INTERNAL_PORT + "/ >/dev/null 2>&1 && echo running || echo stopped", 3000);

  const containersText = containers.stdout.trim();
  sendJson(res, 200, {
    disk: disk.stdout.trim(),
    memory: memory.stdout.trim(),
    uptime: uptime.stdout.trim(),
    containers: containersText === "docker not available" ? null : containersText,
    gooCoreRunning: gooCoreCheck.stdout.trim() === "running",
    gatewayRunning: gatewayCheck.stdout.trim() === "running",
  });
}

async function handleLogs(req, res) {
  const query = parseQuery(req.url || "");
  const service = query.service || "goo-core";
  const lines = Math.min(parseInt(query.lines || "100", 10), 1000);

  const allowedServices = ["goo-core", "gateway", "startup", "control"];
  if (!allowedServices.includes(service)) {
    return sendJson(res, 400, { error: `Invalid service. Allowed: ${allowedServices.join(", ")}` });
  }

  const logFile = join(LOG_DIR, `${service}.log`);
  try {
    const result = await execCommand(`tail -n ${lines} ${JSON.stringify(logFile)}`, 5000);
    const logLines = result.stdout.split("\n").filter((l) => l.length > 0);
    sendJson(res, 200, { lines: logLines });
  } catch {
    sendJson(res, 200, { lines: [] });
  }
}

async function handleEnv(req, res) {
  const body = await readJson(req);
  if (!body.vars || typeof body.vars !== "object") {
    return sendJson(res, 400, { error: "vars (Record<string,string>) is required" });
  }

  try {
    let envContent = "";
    try {
      envContent = await readFile(GOO_CORE_ENV, "utf-8");
    } catch {
      // File may not exist yet
    }

    const envMap = new Map();
    for (const line of envContent.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        envMap.set(line.slice(0, eqIdx), line.slice(eqIdx + 1));
      }
    }

    for (const [key, value] of Object.entries(body.vars)) {
      envMap.set(key, String(value));
    }

    const newContent = Array.from(envMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    await writeFile(GOO_CORE_ENV, newContent, "utf-8");

    let restarted = false;
    if (body.restart) {
      await execCommand("pkill -HUP -f 'goo-core-wrapper' 2>/dev/null || true", 5000);
      restarted = true;
    }

    sendJson(res, 200, {
      applied: Object.keys(body.vars).length,
      restarted,
    });
  } catch (err) {
    sendJson(res, 500, {
      error: "Failed to update env",
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleEnvCheck(_req, res) {
  const REQUIRED_KEYS = [
    "GOO_SERVER_URL", "AGENT_ID", "AGENT_RUNTIME_TOKEN",
    "CHAIN_ID", "RPC_URL", "TOKEN_ADDRESS", "WALLET_PRIVATE_KEY",
    "OPENCLAW_GATEWAY_TOKEN", "OPENAI_BASE_URL", "OPENAI_API_KEY", "LLM_MODEL",
    "ROUTER_ADDRESS", "REGISTRY_ADDRESS", "CONTROL_PORT",
  ];

  try {
    let envContent = "";
    try {
      envContent = await readFile(GOO_CORE_ENV, "utf-8");
    } catch {
      // .env may not exist yet
    }

    const envMap = new Map();
    for (const line of envContent.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        envMap.set(line.slice(0, eqIdx), line.slice(eqIdx + 1));
      }
    }

    // Also check process.env for vars set via Docker -e flags
    const missing = [];
    const present = [];
    const values = {};
    for (const key of REQUIRED_KEYS) {
      const val = envMap.get(key) || process.env[key] || "";
      if (val && val.trim()) {
        present.push(key);
        values[key] = "set";
      } else {
        missing.push(key);
        values[key] = "empty";
      }
    }

    sendJson(res, 200, { missing, present, values });
  } catch (err) {
    sendJson(res, 500, {
      error: "Failed to check env",
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleRestartGateway(_req, res) {
  try {
    await restartGatewayProcess();
    sendJson(res, 200, { restarted: true, running: true });
  } catch (err) {
    sendJson(res, 500, {
      error: "Failed to restart gateway",
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

async function restartGatewayProcess() {
  // Use `openclaw gateway stop` for clean shutdown (handles PID lock file)
  await execCommand("openclaw gateway stop 2>/dev/null || true", 10000);
  await execCommand("sleep 2", 3000);

  const gwPort = GATEWAY_INTERNAL_PORT;
  const gwToken = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || "my-gateway-token";
  const startCmd = `NODE_OPTIONS="--max-old-space-size=2048" nohup openclaw gateway --allow-unconfigured --bind lan --auth token --token "${gwToken}" --port ${gwPort} >> /var/log/sandbox/gateway.log 2>&1 & echo $!`;
  const result = await execCommand(startCmd, 10000);
  console.log(`[control] Gateway restarted (pid=${result.stdout.trim()})`);
}

async function handleRestartGooCore(_req, res) {
  try {
    // Send SIGHUP to goo-core-wrapper which triggers a clean restart
    await execCommand("pkill -HUP -f 'goo-core-wrapper' 2>/dev/null; echo $?", 5000);
    await execCommand("sleep 2", 3000);

    sendJson(res, 200, { restarted: true });
  } catch (err) {
    sendJson(res, 500, {
      error: "Failed to restart goo-core",
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleUpgrade(_req, res) {
  const steps = [];
  const errors = [];

  // 1. Upgrade goo-core
  const gcUpgrade = await execCommand("npm install -g @devbond/gc@latest 2>&1", 120_000);
  if (gcUpgrade.exitCode === 0) {
    const versionMatch = gcUpgrade.stdout.match(/@devbond\/gc@([\d.]+)/);
    steps.push("goo-core upgraded" + (versionMatch ? " to " + versionMatch[1] : ""));
  } else {
    errors.push("goo-core upgrade failed: " + (gcUpgrade.stderr || gcUpgrade.stdout).slice(0, 300));
  }

  // 2. Install chat-sync hook (generate from template)
  const HOOKS_DIR = (process.env.HOME || "/root") + "/.openclaw/hooks";
  await mkdir(HOOKS_DIR, { recursive: true });
  const hookPath = join(HOOKS_DIR, "chat-sync.mjs");
  try {
    await writeFile(hookPath, buildChatSyncHook(), "utf-8");
    steps.push("chat-sync hook installed");
  } catch (err) {
    errors.push("hook install failed: " + err.message);
  }

  // 3. Restart goo-core
  await execCommand("pkill -HUP -f 'goo-core-wrapper' 2>/dev/null; echo $?", 5000);
  steps.push("goo-core restart signaled");

  // 4. Restart gateway (so OpenClaw discovers new hook)
  try {
    await restartGatewayProcess();
    steps.push("gateway restarted");
  } catch (err) {
    errors.push("gateway restart failed: " + err.message);
  }

  sendJson(res, errors.length > 0 ? 207 : 200, { steps, errors });
}

/** Generate the chat-sync hook source code. */
function buildChatSyncHook() {
  // Using array join to avoid template literal escaping issues
  return [
    "/**",
    " * OpenClaw hook: sync agent messages to goo-server chat history.",
    " */",
    "const GOO_SERVER_URL = process.env.GOO_SERVER_URL;",
    "const AGENT_ID = process.env.AGENT_ID;",
    "const AGENT_RUNTIME_TOKEN = process.env.AGENT_RUNTIME_TOKEN;",
    "",
    "export default async function chatSync(event) {",
    '  if (event.type !== "message") return;',
    '  if (event.action !== "sent" && event.action !== "received") return;',
    "  if (!GOO_SERVER_URL || !AGENT_ID || !AGENT_RUNTIME_TOKEN) return;",
    "",
    "  const content = event.content || event.text;",
    '  if (!content || typeof content !== "string" || content.trim().length === 0) return;',
    "",
    '  const role = event.action === "received" ? "user" : "assistant";',
    "  const url = GOO_SERVER_URL + \"/api/agents/\" + AGENT_ID + \"/chat-ingest\";",
    "",
    "  try {",
    "    const resp = await fetch(url, {",
    '      method: "POST",',
    "      headers: {",
    '        "Content-Type": "application/json",',
    '        "Authorization": "Bearer " + AGENT_RUNTIME_TOKEN,',
    "      },",
    "      body: JSON.stringify({",
    "        role,",
    "        content: content.trim(),",
    '        source: event.action === "received" ? "openclaw-inbound" : "openclaw",',
    "        sessionKey: event.sessionKey || undefined,",
    "      }),",
    "      signal: AbortSignal.timeout(10000),",
    "    });",
    '    if (!resp.ok) console.warn("[chat-sync] POST failed: HTTP " + resp.status);',
    "  } catch (err) {",
    '    console.warn("[chat-sync] POST error: " + err.message);',
    "  }",
    "}",
    "",
  ].join("\n");
}

async function handleApply(req, res) {
  try {
    const body = await readJson(req);
    await mkdir(DATA_DIR, { recursive: true });

    const filesWritten = [];
    filesWritten.push(await writeCreatorFile("soul.md", body.genesis_prompt));
    filesWritten.push(await writeCreatorFile("agent.md", body.agent_instructions || body.agent_intro));
    filesWritten.push(await writeCreatorFile("skills.md", body.skills_content));
    filesWritten.push(await writeCreatorFile("memory.md", body.memory_content));

    // Determine if any files actually changed (vs all removed/empty)
    const actualWrites = filesWritten.filter((f) => !f.startsWith("removed:"));
    const restartGateway = body.restart_gateway !== false; // default true

    sendJson(res, 200, {
      applied: true,
      files_written: filesWritten,
      gateway_restart: restartGateway && actualWrites.length > 0,
    });

    // Auto-restart gateway after workspace file updates so OpenClaw picks up fresh context.
    // Short delay to ensure files are flushed to disk before gateway reads them.
    if (restartGateway && actualWrites.length > 0) {
      setTimeout(async () => {
        console.log("[control] Restarting gateway after /control/apply (workspace files updated)");
        try {
          await restartGatewayProcess();
        } catch (err) {
          console.error("[control] Gateway restart failed:", err);
        }
      }, 2000);
    }
  } catch (err) {
    sendJson(res, 500, {
      error: "Failed to apply BYOD config",
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------- Auto-approve device pairing (owner-only) ----------
// OpenClaw requires device pairing for WebSocket connections. Browser connections
// create pending pairing requests that must be approved (openclaw/openclaw#16305).
// Only approve when the connecting client provides the correct gateway token (= owner).

const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || "";
const FULL_SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
let autoApproveRunning = false;

function isOwnerConnection(req) {
  // The OpenClaw Control UI passes the gateway token via Sec-WebSocket-Protocol header
  // or as a query parameter (?token=...). Check both.
  const url = req.url || "";
  const query = parseQuery(url);
  if (GATEWAY_TOKEN && query.token === GATEWAY_TOKEN) return true;

  // Also check Sec-WebSocket-Protocol header (some clients send token there)
  const protocols = req.headers["sec-websocket-protocol"] || "";
  if (GATEWAY_TOKEN && protocols.split(",").map((s) => s.trim()).includes(GATEWAY_TOKEN)) return true;

  // Check Authorization header (used by programmatic clients)
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (GATEWAY_TOKEN && bearerToken === GATEWAY_TOKEN) return true;

  return false;
}

async function autoApproveDevices() {
  if (autoApproveRunning) return;
  autoApproveRunning = true;
  try {
    const list = await execCommand("openclaw devices list 2>/dev/null", 10000);
    const uuids = (list.stdout || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
    if (uuids && uuids.length > 0) {
      for (const id of uuids) {
        const result = await execCommand(`openclaw devices approve ${id} 2>&1`, 10000);
        console.log(`[auto-pair] Approved device: ${id} — ${(result.stdout || "").trim()}`);
      }
      // Fix scopes (openclaw/openclaw#16305: approved devices get incomplete scopes)
      await fixDeviceScopes();
    }
  } catch {
    // Ignore errors
  } finally {
    autoApproveRunning = false;
  }
}

async function fixDeviceScopes() {
  try {
    const pairedPath = (process.env.HOME || "/root") + "/.openclaw/devices/paired.json";
    const content = await readFile(pairedPath, "utf-8");
    const data = JSON.parse(content);
    let changed = false;
    for (const dev of Object.values(data)) {
      if (!dev.scopes || dev.scopes.length < FULL_SCOPES.length) {
        dev.scopes = FULL_SCOPES;
        dev.approvedScopes = FULL_SCOPES;
        if (dev.tokens?.operator) dev.tokens.operator.scopes = FULL_SCOPES;
        changed = true;
      }
    }
    if (changed) {
      await writeFile(pairedPath, JSON.stringify(data, null, 2), "utf-8");
      console.log("[auto-pair] Fixed device scopes");
    }
  } catch {
    // Ignore — file may not exist yet
  }
}

// ---------- Reverse proxy to gateway ----------

import { connect } from "node:net";

function proxyRequest(req, res) {
  const proxyReq = httpRequest(
    {
      hostname: "127.0.0.1",
      port: GATEWAY_INTERNAL_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gateway unreachable", details: err.message }));
    }
  });

  req.pipe(proxyReq, { end: true });
}

function proxyUpgrade(req, socket, head) {
  const proxySocket = connect(GATEWAY_INTERNAL_PORT, "127.0.0.1", () => {
    // Reconstruct the raw HTTP upgrade request line + headers
    const reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    const hdrs = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    proxySocket.write(reqLine + hdrs + "\r\n\r\n");
    if (head && head.length > 0) proxySocket.write(head);

    proxySocket.pipe(socket, { end: true });
    socket.pipe(proxySocket, { end: true });
  });

  proxySocket.on("error", () => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  socket.on("error", () => {
    proxySocket.destroy();
  });
}

// ---------- Server ----------

const server = createServer(async (req, res) => {
  const fullUrl = req.url || "";
  const path = fullUrl.split("?")[0];

  // --- /control/* paths: handled locally ---
  if (path.startsWith("/control/")) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // Healthz is public (no auth)
    if (req.method === "GET" && path === "/control/healthz") {
      sendJson(res, 200, { ok: true, port: PORT });
      return;
    }

    // All other /control/* require auth
    if (!checkAuth(req)) {
      sendJson(res, 401, { error: "Invalid token" });
      return;
    }

    try {
      if (req.method === "POST" && path === "/control/apply") return await handleApply(req, res);
      if (req.method === "POST" && path === "/control/exec") return await handleExec(req, res);
      if (req.method === "GET" && path === "/control/status") return await handleStatus(req, res);
      if (req.method === "GET" && path === "/control/logs") return await handleLogs(req, res);
      if (req.method === "POST" && path === "/control/env") return await handleEnv(req, res);
      if (req.method === "GET" && path === "/control/env-check") return await handleEnvCheck(req, res);
      if (req.method === "POST" && path === "/control/restart-gateway") return await handleRestartGateway(req, res);
      if (req.method === "POST" && path === "/control/restart-goo-core") return await handleRestartGooCore(req, res);
      if (req.method === "POST" && path === "/control/upgrade") return await handleUpgrade(req, res);

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      sendJson(res, 500, {
        error: "Internal error",
        details: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // --- Everything else: reverse proxy to OpenClaw gateway ---
  proxyRequest(req, res);
});

// Handle WebSocket upgrades (proxy to gateway)
// On owner connections, trigger auto-approve so pending pairing requests get approved.
// The browser's first attempt may fail (pairing required), but after auto-approve
// runs and the browser auto-reconnects, the second attempt succeeds.
server.on("upgrade", (req, socket, head) => {
  if (isOwnerConnection(req)) {
    // Owner is connecting — approve any pending device requests in the background.
    // Don't await; the current WS attempt may fail but the next reconnect will succeed.
    autoApproveDevices();
  }
  proxyUpgrade(req, socket, head);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[control] Listening on :${PORT} — /control/* handled locally, rest proxied to gateway :${GATEWAY_INTERNAL_PORT}`);
});

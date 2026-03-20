/**
 * OpenClaw hook: sync agent messages to goo-server chat history.
 *
 * Fires on message:received (user → agent) and message:sent (agent → user/system).
 * POSTs to the goo-server chat-ingest endpoint so all OpenClaw conversation
 * (including heartbeat-triggered autonomous responses) appears in the chat UI.
 */

const GOO_SERVER_URL = process.env.GOO_SERVER_URL;
const AGENT_ID = process.env.AGENT_ID;
const AGENT_RUNTIME_TOKEN = process.env.AGENT_RUNTIME_TOKEN;

export default async function chatSync(event) {
  // Only handle message events
  if (event.type !== "message") return;
  if (event.action !== "sent" && event.action !== "received") return;

  // Need server config to push messages
  if (!GOO_SERVER_URL || !AGENT_ID || !AGENT_RUNTIME_TOKEN) return;

  const content = event.content || event.text;
  if (!content || typeof content !== "string" || content.trim().length === 0) return;

  const role = event.action === "received" ? "user" : "assistant";
  const url = `${GOO_SERVER_URL}/api/agents/${AGENT_ID}/chat-ingest`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AGENT_RUNTIME_TOKEN}`,
      },
      body: JSON.stringify({
        role,
        content: content.trim(),
        source: event.action === "received" ? "openclaw-inbound" : "openclaw",
        sessionKey: event.sessionKey || undefined,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.warn(`[chat-sync] POST failed: HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[chat-sync] POST error: ${err.message}`);
  }
}

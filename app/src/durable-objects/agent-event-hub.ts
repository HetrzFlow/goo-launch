import { DurableObject } from 'cloudflare:workers';

export class AgentEventHub extends DurableObject {
  private sessions: Set<WebSocket> = new Set();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      // WebSocket upgrade
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      this.sessions.add(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (url.pathname === '/emit' && request.method === 'POST') {
      // Broadcast event to all connected WebSocket clients
      const event = await request.json();
      const message = JSON.stringify(event);

      for (const ws of this.sessions) {
        try {
          ws.send(message);
        } catch {
          this.sessions.delete(ws);
        }
      }

      return new Response(JSON.stringify({ ok: true, clients: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  webSocketClose(ws: WebSocket): void {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.sessions.delete(ws);
  }
}

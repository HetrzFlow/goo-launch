import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../bindings';
import { sshExec } from '../ssh-exec';
import { checkProvisionHealth } from '../agos-provision';

type ProvisionStep = 'connecting' | 'pulling' | 'starting' | 'health_check' | 'live' | 'error';

interface ProvisionState {
  step: ProvisionStep;
  message: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

interface ProvisionRequest {
  agenterId: string;
  host: string;
  password: string;
  script: string;
  gatewayPort: string;
}

const PROVISION_LOG = '/tmp/goo-provision.log';
const PROVISION_SCRIPT = '/tmp/goo-provision.sh';


export class AgentProvisioner extends DurableObject<Env> {
  private state: ProvisionState = {
    step: 'connecting',
    message: 'Idle',
    startedAt: 0,
  };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/provision' && request.method === 'POST') {
      const body = (await request.json()) as ProvisionRequest;
      this.ctx.waitUntil(this.runProvision(body));
      return Response.json({ ok: true, message: 'Provisioning started' });
    }

    if (url.pathname === '/status') {
      return Response.json({ ok: true, state: this.state });
    }

    return new Response('Not found', { status: 404 });
  }

  private async emitProgress(agenterId: string, step: ProvisionStep, message: string): Promise<void> {
    this.state = { ...this.state, step, message };

    const id = this.env.AGENT_EVENT_HUB.idFromName(agenterId);
    const stub = this.env.AGENT_EVENT_HUB.get(id);
    await stub.fetch(new Request('http://do/emit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: '',
        agent_id: agenterId,
        timestamp: new Date().toISOString(),
        display_text: message,
        phase: 'preparing',
        message_type: 'system',
        provision_step: step,
      }),
    })).catch(() => {});
  }

  /** Quick SSH: run a short command and return stdout. */
  private ssh(host: string, password: string, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return sshExec({ host, password, command, timeoutMs: 15_000 });
  }

  private async runProvision(req: ProvisionRequest): Promise<void> {
    const { agenterId, host, password, script, gatewayPort } = req;
    this.state = { step: 'connecting', message: 'Connecting to VPS...', startedAt: Date.now() };

    try {
      // Step 1: Upload script and launch via nohup (instant SSH, < 1s)
      await this.emitProgress(agenterId, 'connecting', `Connecting to VPS ${host}...`);

      // Escape script content for heredoc
      const uploadAndLaunch = [
        `cat > ${PROVISION_SCRIPT} << 'GOOEOF'`,
        script,
        'GOOEOF',
        `chmod +x ${PROVISION_SCRIPT}`,
        `nohup bash ${PROVISION_SCRIPT} > ${PROVISION_LOG} 2>&1 &`,
        `echo $!`,
      ].join('\n');

      const launch = await this.ssh(host, password, uploadAndLaunch);
      if (launch.exitCode !== 0) {
        await this.emitProgress(agenterId, 'error', `Failed to start provision: ${launch.stderr.slice(-200)}`);
        this.state.error = launch.stderr;
        this.state.completedAt = Date.now();
        return;
      }

      const pid = launch.stdout.trim().split('\n').pop()?.trim();
      await this.emitProgress(agenterId, 'pulling', `Script launched (PID ${pid}), pulling Docker image...`);

      // Step 2-3: Poll log file for progress markers (short SSH sessions, 5s interval)
      const maxPolls = 36; // 36 * 5s = 3 min
      for (let i = 0; i < maxPolls; i++) {
        await new Promise(r => setTimeout(r, 5_000));

        const poll = await this.ssh(host, password,
          `cat ${PROVISION_LOG} 2>/dev/null; echo "---GOOCHECK---"; kill -0 ${pid} 2>/dev/null && echo RUNNING || echo DONE`
        ).catch(() => null);

        if (!poll) continue; // SSH hiccup, retry

        const parts = poll.stdout.split('---GOOCHECK---');
        const log = parts[0] || '';
        const status = (parts[1] || '').trim();

        // Parse progress markers
        if (log.includes('[GOO:STARTING]')) {
          await this.emitProgress(agenterId, 'starting', 'Starting container...');
        } else if (log.includes('[GOO:PULLING]')) {
          await this.emitProgress(agenterId, 'pulling', 'Pulling Docker image...');
        }

        // Check if script finished
        if (status === 'DONE') {
          if (log.includes('[GOO:DONE]')) {
            // Script completed successfully
            break;
          } else {
            // Script exited but no DONE marker — likely failed
            const tail = log.slice(-300);
            await this.emitProgress(agenterId, 'error', `Script exited unexpectedly: ${tail}`);
            this.state.error = tail;
            this.state.completedAt = Date.now();
            return;
          }
        }
      }

      // Step 4: Health check
      await this.emitProgress(agenterId, 'health_check', 'Verifying container health...');

      let healthy = false;
      for (let i = 0; i < 6; i++) {
        const health = await checkProvisionHealth(host, gatewayPort);
        if (health.ok) {
          healthy = true;
          break;
        }
        await new Promise(r => setTimeout(r, 5_000));
      }

      if (healthy) {
        await this.emitProgress(agenterId, 'live', 'Agent is live!');
      } else {
        await this.emitProgress(agenterId, 'live', 'Container started. Health check pending — may take a moment to fully boot.');
      }
      this.state.completedAt = Date.now();
    } catch (err) {
      const message = (err as Error).message || 'SSH connection failed';
      await this.emitProgress(agenterId, 'error', `Provision failed: ${message}`);
      this.state.error = message;
      this.state.completedAt = Date.now();
    }
  }
}

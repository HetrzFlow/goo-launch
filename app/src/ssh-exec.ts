/**
 * SSH exec wrapper using the `ssh2` npm package.
 * Works in Cloudflare Workers with `nodejs_compat` (compatibility_date >= 2025-12-01).
 */
import { Client } from 'ssh2';

export interface SshExecOptions {
  host: string;
  port?: number;
  username?: string;
  password: string;
  command: string;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface SshExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Connect to a remote host via SSH (password auth) and execute a command.
 * Returns stdout/stderr and the exit code.
 */
export function sshExec(opts: SshExecOptions): Promise<SshExecResult> {
  const {
    host,
    port = 22,
    username = 'root',
    password,
    command,
    timeoutMs = 180_000,
    onOutput,
  } = opts;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        reject(new Error(`SSH exec timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          settled = true;
          clearTimeout(timer);
          conn.end();
          reject(err);
          return;
        }

        stream.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          onOutput?.(chunk);
        });

        stream.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          onOutput?.(chunk);
        });

        stream.on('close', (code: number) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            conn.end();
            resolve({ exitCode: code ?? 0, stdout, stderr });
          }
        });
      });
    });

    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 30_000,
      // Accept any host key (AGOS VPS are ephemeral)
      hostVerifier: () => true,
      // Force non-AEAD ciphers — CF Workers' crypto polyfill doesn't support getAuthTag/setAuthTag
      algorithms: {
        cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
      },
    });
  });
}

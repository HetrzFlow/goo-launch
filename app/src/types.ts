/** Execution phases for the agent timeline. */
export type ExecutionPhase = 'planning' | 'preparing' | 'running' | 'reviewing' | 'finalizing';

/** Structured result from sandbox operations. */
export interface SandboxResult {
  status: 'success' | 'error' | 'timeout' | 'denied';
  summary: string;
  artifacts: Array<{
    type: 'file' | 'image' | 'log';
    name: string;
    path: string;
  }>;
  observations: string[];
  metrics: {
    duration_ms: number;
    exit_code: number;
  };
  raw?: {
    stdout_tail: string;
    stderr_tail: string;
    full_exit_code: number;
  };
}

/** Real-time event sent via SSE. */
export interface AgentStreamEvent {
  task_id: string;
  agent_id: string;
  session_id?: string;
  timestamp: string;
  step_id?: string;
  display_text: string;
  phase: ExecutionPhase;
  message_type: 'reasoning' | 'execution' | 'result' | 'system';
  debug_payload?: unknown;
}

/** Human-readable phase descriptions. */
export const PHASE_DISPLAY: Record<ExecutionPhase, string> = {
  planning: 'Generating execution plan...',
  preparing: 'Setting up isolated environment...',
  running: 'Executing in sandbox...',
  reviewing: 'Analyzing results...',
  finalizing: 'Preparing final response...',
};

import { getToken } from '../api';
import { el } from '../dom-utils';
import type { ExecutionPhase, StreamEvent } from './types';
import { PHASE_ORDER, PHASE_LABELS, PHASE_ICONS, PHASE_STATUS } from './constants';

// --- State ---

let eventSource: EventSource | null = null;
let currentPhase: ExecutionPhase | null = null;
const completedPhases: Set<ExecutionPhase> = new Set();

export function getEventSource(): EventSource | null {
  return eventSource;
}

export function closeEventSource(): void {
  if (eventSource) { eventSource.close(); eventSource = null; }
}

export function resetTimelineState(): void {
  currentPhase = null;
  completedPhases.clear();
}

// --- Timeline card ---

export function buildTimelineCard(): HTMLElement {
  const card = el('div', { className: 'card', id: 'timeline-card' },
    el('div', { className: 'card-title' }, 'Execution Timeline'),
  );

  const timeline = el('div', { className: 'execution-timeline' });

  for (const phase of PHASE_ORDER) {
    const isCompleted = completedPhases.has(phase);
    const isActive = currentPhase === phase;
    const stepClass = isCompleted ? 'completed' : isActive ? 'active' : '';

    const dotContent = isCompleted ? '\u2713' : PHASE_ICONS[phase];
    const step = el('div', { className: `timeline-step ${stepClass}`, 'data-phase': phase } as any,
      el('div', { className: 'timeline-dot' }, dotContent),
      el('div', { className: 'timeline-label' }, PHASE_LABELS[phase]),
    );

    if (isActive) {
      step.appendChild(el('div', { className: 'timeline-status' }, PHASE_STATUS[phase]));
    }

    timeline.appendChild(step);
  }

  card.appendChild(timeline);

  if (!currentPhase && completedPhases.size === 0) {
    card.appendChild(el('div', { style: 'text-align:center;font-size:12px;color:#94a3b8;padding-bottom:8px' },
      'Waiting for agent activity...'));
  }

  return card;
}

function updateTimeline(phase: ExecutionPhase): void {
  const idx = PHASE_ORDER.indexOf(phase);
  for (let i = 0; i < idx; i++) {
    completedPhases.add(PHASE_ORDER[i]);
  }
  currentPhase = phase;

  const existing = document.getElementById('timeline-card');
  if (existing) {
    const newCard = buildTimelineCard();
    existing.replaceWith(newCard);
  }
}

// --- SSE ---

export function connectSSE(agentId: string, activityContainer: HTMLElement): void {
  if (eventSource) { eventSource.close(); }

  const token = getToken();
  if (!token) return;

  const apiBase = (import.meta as any).env?.VITE_API_URL || '';
  const url = `${apiBase}/api/agents/${agentId}/stream?token=${encodeURIComponent(token)}`;
  eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const event: StreamEvent = JSON.parse(e.data);
      updateTimeline(event.phase);
      appendStreamActivity(event, activityContainer);
    } catch { /* ignore malformed events */ }
  };

  eventSource.onerror = () => {
    if (eventSource) { eventSource.close(); eventSource = null; }
    setTimeout(() => {
      if (!eventSource) connectSSE(agentId, activityContainer);
    }, 10_000);
  };
}

function appendStreamActivity(event: StreamEvent, container: HTMLElement): void {
  const msgDiv = el('div', { className: `chat-msg ${event.message_type === 'system' ? 'system' : ''}` });

  let bubbleClass = 'chat-bubble ';
  let icon = '';
  switch (event.message_type) {
    case 'reasoning':
      bubbleClass += 'reasoning-bubble';
      icon = '\uD83E\uDDE0 ';
      break;
    case 'execution':
      bubbleClass += 'execution-bubble';
      icon = '> ';
      break;
    case 'result':
      bubbleClass += 'result-bubble success';
      break;
    case 'system':
      bubbleClass += 'system-bubble';
      break;
  }

  msgDiv.appendChild(el('span', { className: bubbleClass }, `${icon}${event.display_text}`));

  const meta = el('div', { className: 'chat-meta' },
    `${event.phase} \u00B7 ${new Date(event.timestamp).toLocaleTimeString()}`);
  msgDiv.appendChild(meta);

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
}

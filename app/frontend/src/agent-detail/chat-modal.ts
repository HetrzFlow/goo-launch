import { api } from '../api';
import { el, clearChildren } from '../dom-utils';
import type { AgentDetail, ChatResponse, ChatHistoryResponse, ChatMessageRecord } from './types';

// --- Module-scope state (persists across open/close) ---

let modalEl: HTMLElement | null = null;
let chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
let oldestMessageId: number | null = null;
let hasMore = false;
let chatLoaded = false;
let currentAgentId: number | null = null;

/** Reset chat state when agent changes. */
function resetIfNewAgent(agentId: number): void {
  if (currentAgentId !== agentId) {
    chatHistory = [];
    oldestMessageId = null;
    hasMore = false;
    chatLoaded = false;
    currentAgentId = agentId;
  }
}

/** Determine the chat endpoint based on agent config. */
function getChatEndpoint(detail: AgentDetail): string {
  const isE2b = detail.sandboxProvider === 'e2b';
  if (isE2b && detail.sandboxId) {
    return `/api/sandbox/${detail.agenterId}/chat`;
  }
  return `/api/agents/${detail.id}/chat`;
}

/** Build chat request body. Sandbox endpoint doesn't need history. */
function getChatBody(detail: AgentDetail, text: string): Record<string, unknown> {
  const isSandboxEndpoint = getChatEndpoint(detail).includes('/sandbox/');
  if (isSandboxEndpoint) {
    return { message: text };
  }
  return { message: text, history: chatHistory.slice(0, -1) };
}

/** Open the chat modal for an agent. */
export function openChatModal(detail: AgentDetail): void {
  resetIfNewAgent(detail.id);

  // Remove existing modal if any
  if (modalEl) {
    modalEl.remove();
    modalEl = null;
  }

  // Backdrop
  const backdrop = el('div', { className: 'chat-modal-backdrop' });

  // Modal container
  const modal = el('div', { className: 'chat-modal' });

  // Header
  const header = el('div', { className: 'chat-modal-header' });

  const titleArea = el('div', { style: 'display:flex;align-items:center;gap:10px' });
  titleArea.appendChild(el('span', { className: 'chat-modal-title' }, `Chat with ${detail.agentName || detail.agenterId}`));

  const hasGateway = !!detail.gatewayUrl;
  const hasSandbox = !!detail.sandboxId;
  const modeLabel = detail.llmProvider === 'agos'
    ? 'AGOS'
    : hasGateway
      ? 'OpenClaw'
      : hasSandbox
        ? 'Sandbox'
        : 'Direct LLM';
  const modeColor = detail.llmProvider === 'agos'
    ? '#b45309'
    : hasGateway
      ? '#00C7D2'
      : hasSandbox
        ? '#2563eb'
        : '#94a3b8';
  titleArea.appendChild(el('span', { className: 'chat-modal-mode' , style: `color:${modeColor}` },
    el('span', { style: `width:6px;height:6px;border-radius:50%;background:${modeColor};display:inline-block` }),
    ` ${modeLabel}`,
  ));
  header.appendChild(titleArea);

  const closeBtn = el('button', { className: 'chat-modal-close' }, '\u2715');
  closeBtn.addEventListener('click', closeChatModal);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Messages area
  const messagesContainer = el('div', { className: 'chat-modal-messages' });
  modal.appendChild(messagesContainer);

  // Input area
  const inputArea = el('div', { className: 'chat-modal-input-area' });
  const input = el('textarea', {
    className: 'chat-modal-input',
    placeholder: 'Type a message...',
  }) as HTMLTextAreaElement;
  input.rows = 1;
  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  const sendBtn = el('button', { className: 'chat-modal-send' }, 'Send') as HTMLButtonElement;
  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);
  modal.appendChild(inputArea);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modalEl = backdrop;

  // Focus input
  setTimeout(() => input.focus(), 100);

  // Close on backdrop click
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeChatModal();
  });

  // Close on Escape
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeChatModal();
  };
  document.addEventListener('keydown', onKey);
  backdrop.setAttribute('data-esc-handler', 'true');
  (backdrop as any).__escHandler = onKey;

  // Load or render chat history
  if (!chatLoaded) {
    loadChatHistory(detail.id, messagesContainer).then(result => {
      oldestMessageId = result.oldestId;
      hasMore = result.hasMore;
      chatLoaded = true;
      if (chatHistory.length === 0) {
        messagesContainer.appendChild(el('div', { className: 'chat-modal-placeholder' },
          detail.llmProvider === 'agos' ? 'Connected to AGOS. Send a message.' :
          hasGateway ? 'Connected to OpenClaw. Send a message.' :
          hasSandbox ? 'Connected to Sandbox. Send a message.' :
          'Send a message to your agent.'));
      }
    });
  } else {
    renderExistingHistory(messagesContainer);
    setTimeout(() => { messagesContainer.scrollTop = messagesContainer.scrollHeight; }, 0);
  }

  // Scroll-to-top for more
  messagesContainer.addEventListener('scroll', () => {
    if (hasMore && messagesContainer.scrollTop === 0 && oldestMessageId) {
      const prevHeight = messagesContainer.scrollHeight;
      loadMoreHistory(detail.id, oldestMessageId, messagesContainer).then(result => {
        oldestMessageId = result.oldestId ?? oldestMessageId;
        hasMore = result.hasMore;
        messagesContainer.scrollTop = messagesContainer.scrollHeight - prevHeight;
      });
    }
  });

  // Send
  async function sendMessage(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;

    const placeholder = messagesContainer.querySelector('.chat-modal-placeholder');
    if (placeholder) placeholder.remove();

    messagesContainer.appendChild(el('div', { className: 'chat-msg user' },
      el('span', { className: 'chat-bubble user-bubble' }, text)));
    chatHistory.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    sendBtn.textContent = '...';

    const typingEl = el('div', { className: 'chat-msg' },
      el('span', { className: 'chat-bubble reasoning-bubble' }, 'Thinking...'));
    messagesContainer.appendChild(typingEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    try {
      const endpoint = getChatEndpoint(detail);
      const body = getChatBody(detail, text);
      const resp = await api<ChatResponse>('POST', endpoint, body);
      chatHistory.push({ role: 'assistant', content: resp.reply });
      messagesContainer.removeChild(typingEl);

      const replyBubble = el('div', { className: 'chat-msg' });
      replyBubble.appendChild(el('span', { className: 'chat-bubble result-bubble success' }, resp.reply));
      const metaParts: string[] = [];
      if (resp.model) metaParts.push(resp.model);
      if (resp.tier) metaParts.push(resp.tier);
      if (resp.via) metaParts.push(resp.via === 'openclaw' ? 'via OpenClaw' : `via ${resp.via}`);
      if (metaParts.length > 0) {
        replyBubble.appendChild(el('div', { className: 'chat-meta' }, metaParts.join(' \u00B7 ')));
      }
      messagesContainer.appendChild(replyBubble);
    } catch (err) {
      messagesContainer.removeChild(typingEl);
      messagesContainer.appendChild(el('div', { className: 'chat-msg' },
        el('span', { className: 'chat-bubble result-bubble error', style: 'color:#e05050' },
          `Error: ${(err as Error).message}`)));
    }

    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !sendBtn.disabled) {
      e.preventDefault();
      sendMessage();
    }
  });
}

/** Close the chat modal. */
export function closeChatModal(): void {
  if (modalEl) {
    const handler = (modalEl as any).__escHandler;
    if (handler) document.removeEventListener('keydown', handler);
    modalEl.remove();
    modalEl = null;
  }
}

/** Build a "Chat with Goo" button that opens the modal. */
export function buildChatButton(detail: AgentDetail): HTMLElement {
  const btn = el('button', { className: 'chat-fab' }, 'Chat with Goo');
  btn.addEventListener('click', () => openChatModal(detail));
  return btn;
}

// --- History helpers ---

function renderExistingHistory(container: HTMLElement): void {
  for (const msg of chatHistory) {
    if (msg.role === 'user') {
      container.appendChild(el('div', { className: 'chat-msg user' },
        el('span', { className: 'chat-bubble user-bubble' }, msg.content)));
    } else {
      container.appendChild(el('div', { className: 'chat-msg' },
        el('span', { className: 'chat-bubble result-bubble success' }, msg.content)));
    }
  }
}

async function loadChatHistory(
  agentId: number,
  container: HTMLElement,
): Promise<{ oldestId: number | null; hasMore: boolean }> {
  try {
    const resp = await api<ChatHistoryResponse>('GET', `/api/agents/${agentId}/chat-history?limit=50`);
    if (resp.messages.length === 0) {
      return { oldestId: null, hasMore: false };
    }

    clearChildren(container);
    for (const msg of resp.messages) {
      renderHistoryMessage(msg, container);
      if (msg.role === 'user' || msg.role === 'assistant') {
        chatHistory.push({ role: msg.role, content: msg.content });
      }
    }
    container.scrollTop = container.scrollHeight;

    return {
      oldestId: resp.messages[0].id,
      hasMore: resp.has_more,
    };
  } catch {
    return { oldestId: null, hasMore: false };
  }
}

async function loadMoreHistory(
  agentId: number,
  beforeId: number,
  container: HTMLElement,
): Promise<{ oldestId: number | null; hasMore: boolean }> {
  try {
    const resp = await api<ChatHistoryResponse>('GET', `/api/agents/${agentId}/chat-history?limit=50&before=${beforeId}`);
    if (resp.messages.length === 0) {
      return { oldestId: null, hasMore: false };
    }

    const fragment = document.createDocumentFragment();
    const olderHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const msg of resp.messages) {
      renderHistoryMessage(msg, fragment as unknown as HTMLElement);
      if (msg.role === 'user' || msg.role === 'assistant') {
        olderHistory.push({ role: msg.role, content: msg.content });
      }
    }
    container.prepend(fragment);
    chatHistory.unshift(...olderHistory);

    return {
      oldestId: resp.messages[0].id,
      hasMore: resp.has_more,
    };
  } catch {
    return { oldestId: null, hasMore: false };
  }
}

function renderHistoryMessage(msg: ChatMessageRecord, container: HTMLElement | DocumentFragment): void {
  if (msg.role === 'user') {
    container.appendChild(el('div', { className: 'chat-msg user' },
      el('span', { className: 'chat-bubble user-bubble' }, msg.content)));
  } else if (msg.role === 'assistant') {
    const div = el('div', { className: 'chat-msg' });
    div.appendChild(el('span', { className: 'chat-bubble result-bubble success' }, msg.content));

    const metaParts: string[] = [];
    if (msg.model) metaParts.push(msg.model);
    if (msg.tier) metaParts.push(msg.tier);
    if (msg.via) metaParts.push(msg.via === 'openclaw' ? 'via OpenClaw' : msg.via);
    if (metaParts.length > 0) {
      div.appendChild(el('div', { className: 'chat-meta' }, metaParts.join(' \u00B7 ')));
    }

    const timeStr = new Date(msg.createdAt).toLocaleString();
    div.appendChild(el('div', { style: 'font-size:10px;color:#B2B2B2;margin-top:2px;padding-left:4px' }, timeStr));
    container.appendChild(div);
  }
}

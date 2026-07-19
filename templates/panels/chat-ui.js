// Companion chat UI (runtime surface only).
//
// Config editing now lives in the main ⚙ Settings panel (lil-gui) — see
// chat-panel.js `buildCompanionSettings`. This module keeps the conversation
// surface: compact card, expanded chat, live utterance, and the runtime status
// readouts (connection / memory / timer / busy).
import { mergeConfig } from './default-config.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export class CompanionUI {
  constructor({
    config,
    onSend,
    onConfigChange,
    onConnectionRefresh,
    onConversationActivity,
    mountTarget,
  }) {
    this.config = mergeConfig(config);
    this.onSend = onSend;
    this.onConfigChange = onConfigChange || (() => {});
    this.onConnectionRefresh = onConnectionRefresh || (() => {});
    this.onConversationActivity = onConversationActivity || (() => {});
    this.mountTarget = mountTarget || document.getElementById('chat-panel') || document.body;
    this.messageCount = 0;
    this.chatDisplayMode = this.config.ui.chatDisplayModeDefault;
    this.liveUtterance = '';
    this.hasUnreadUtterance = false;
    this.#mount();
    this.syncConfig(this.config);
  }

  #mount() {
    const root = document.createElement('div');
    root.id = 'companion-shell';
    // Minimal surface: conversation log + input + send. Header (speaker, live
    // banner, status readouts, refresh/collapse buttons) and the collapsed
    // "compact card" were removed — the dialog is always expanded.
    root.innerHTML = `
      <section id="companion-chat" class="companion-chat">
        <div id="companion-messages" class="companion-messages"></div>
        <form id="companion-input-form" class="companion-input-form">
          <textarea id="companion-input" rows="2" placeholder="对她说点什么..."></textarea>
          <button id="companion-send" class="companion-primary-btn" type="submit">发送</button>
        </form>
      </section>
    `;
    this.mountTarget.appendChild(root);

    this.root = root;
    this.messagesEl = root.querySelector('#companion-messages');
    // The following runtime readouts no longer have DOM nodes (header removed).
    // Setters guard against null so the chat orchestration keeps running.
    this.timerEl = null;
    this.compactTimerEl = null;
    this.busyEl = null;
    this.connectionEl = null;
    this.memoryStatsEl = null;
    this.speakerEl = null;
    this.compactSpeakerEl = null;
    this.liveBannerEl = null;
    this.liveUtteranceEl = null;
    this.compactUnreadEl = null;
    this.chatEl = root.querySelector('#companion-chat');
    this.compactEl = null;

    this.form = root.querySelector('#companion-input-form');
    this.input = root.querySelector('#companion-input');

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const message = this.input.value.trim();
      if (!message) {
        return;
      }
      this.input.value = '';
      this.onConversationActivity('send');
      this.onSend(message);
    });

    this.input.addEventListener('keydown', (event) => {
      this.onConversationActivity('typing');
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });

    this.input.addEventListener('focus', () => {
      this.onConversationActivity('focus');
    });
    // Header buttons (refresh connection / expand / collapse) were removed; the
    // dialog is always expanded. Connection refresh still runs on mount via
    // chat-panel's refreshHealth().
  }

  // Config is edited in the main ⚙ Settings panel; here we only refresh the
  // non-field surface (speaker label, theme, chat display mode).
  syncConfig(config) {
    this.config = mergeConfig(config, this.config);
    if (this.speakerEl) this.speakerEl.textContent = this.config.persona.speakerName;
    if (this.compactSpeakerEl) this.compactSpeakerEl.textContent = this.config.persona.speakerName;
    document.body.dataset.companionTheme = this.config.ui.theme;
    // Dialog is always expanded now — no display-mode toggling.
  }

  appendMessage(role, content, meta = {}) {
    this.messageCount += 1;
    const item = document.createElement('article');
    item.className = `companion-message is-${role}`;
    item.innerHTML = `
      <header>${role === 'assistant' ? escapeHtml(this.config.persona.speakerName) : 'You'}</header>
      <p>${escapeHtml(content).replaceAll('\n', '<br>')}</p>
    `;
    this.messagesEl.appendChild(item);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

    if (role === 'assistant') {
      this.setLiveUtterance(content, { unread: meta.source === 'timer', source: meta.source || 'assistant' });
    }
  }

  // The live-utterance banner was removed with the header; keep the state so the
  // orchestration can still call this, but only touch DOM nodes that exist.
  setLiveUtterance(content, options = {}) {
    this.liveUtterance = content || '等待她开口...';
    this.hasUnreadUtterance = Boolean(options.unread);
    if (this.liveBannerEl) this.liveBannerEl.textContent = this.liveUtterance;
    if (this.liveUtteranceEl) this.liveUtteranceEl.textContent = this.liveUtterance;
    if (this.root) this.root.classList.toggle('has-unread-utterance', this.hasUnreadUtterance);
  }

  // Dialog is always expanded now; kept as a no-op so callers stay unchanged.
  setChatDisplayMode() {
    this.chatDisplayMode = 'expanded';
    if (this.root) this.root.dataset.chatDisplayMode = 'expanded';
  }

  isCollapsed() {
    return false;
  }

  setBusy(isBusy, detail = 'idle') {
    if (this.busyEl) this.busyEl.textContent = `状态: ${detail}`;
    if (this.root) this.root.classList.toggle('is-busy', isBusy);
  }

  setConnectionStatus(text, kind = 'neutral') {
    if (!this.connectionEl) return;
    this.connectionEl.textContent = text;
    this.connectionEl.dataset.kind = kind;
  }

  setTimerCountdown(seconds) {
    if (!this.timerEl && !this.compactTimerEl) return;
    const text = Number.isFinite(seconds)
      ? `下一次主动发言: ${Math.max(0, Math.ceil(seconds))}s`
      : '下一次主动发言: --';
    if (this.timerEl) this.timerEl.textContent = text;
    if (this.compactTimerEl) this.compactTimerEl.textContent = text;
  }

  setMemoryStats(stats) {
    if (!this.memoryStatsEl) return;
    this.memoryStatsEl.textContent = `最近 ${stats.recentCount} 条消息 · ${stats.diaryCount} 条关系记忆 · 已累积 ${stats.turnsSinceCompress} 条新轮次`;
  }
}

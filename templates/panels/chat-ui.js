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
    root.innerHTML = `
      <section id="companion-compact" class="companion-compact">
        <div class="companion-compact-copy">
          <div class="companion-compact-line">
            <span id="companion-compact-speaker" class="companion-compact-speaker">陪伴助手</span>
            <span id="companion-compact-unread" class="companion-compact-unread" aria-hidden="true"></span>
          </div>
          <p id="companion-live-utterance" class="companion-live-utterance">等待她开口...</p>
          <div id="companion-compact-timer" class="companion-compact-timer">下一次主动发言: --</div>
        </div>
        <div class="companion-compact-actions">
          <button id="companion-expand-chat" class="companion-secondary-btn" type="button">展开对话</button>
        </div>
      </section>
      <section id="companion-chat" class="companion-chat">
        <div class="companion-chat-header">
          <div>
            <div class="companion-chat-kicker">RPG Dialogue</div>
            <h2 id="companion-speaker">陪伴助手</h2>
            <p id="companion-live-banner" class="companion-live-banner">等待她开口...</p>
          </div>
          <div class="companion-chat-side">
            <div class="companion-chat-meta">
              <div id="companion-timer">下一次主动发言: --</div>
              <div id="companion-busy">状态: idle</div>
              <div id="connection-status" class="companion-connection-status">等待连接...</div>
              <div id="memory-stats" class="companion-memory-stats">最近 0 条消息 · 0 条关系记忆</div>
            </div>
            <div class="companion-chat-actions">
              <button id="companion-refresh-health" class="companion-secondary-btn" type="button">刷新连接</button>
              <button id="companion-collapse-chat" class="companion-secondary-btn" type="button">折叠</button>
            </div>
          </div>
        </div>
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
    this.timerEl = root.querySelector('#companion-timer');
    this.compactTimerEl = root.querySelector('#companion-compact-timer');
    this.busyEl = root.querySelector('#companion-busy');
    this.connectionEl = root.querySelector('#connection-status');
    this.memoryStatsEl = root.querySelector('#memory-stats');
    this.speakerEl = root.querySelector('#companion-speaker');
    this.compactSpeakerEl = root.querySelector('#companion-compact-speaker');
    this.liveBannerEl = root.querySelector('#companion-live-banner');
    this.liveUtteranceEl = root.querySelector('#companion-live-utterance');
    this.compactUnreadEl = root.querySelector('#companion-compact-unread');
    this.chatEl = root.querySelector('#companion-chat');
    this.compactEl = root.querySelector('#companion-compact');

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

    root.querySelector('#companion-refresh-health').addEventListener('click', () => this.onConnectionRefresh());
    root.querySelector('#companion-expand-chat').addEventListener('click', () => {
      this.setChatDisplayMode('expanded');
    });
    root.querySelector('#companion-collapse-chat').addEventListener('click', () => {
      this.setChatDisplayMode('collapsed');
    });
  }

  // Config is edited in the main ⚙ Settings panel; here we only refresh the
  // non-field surface (speaker label, theme, chat display mode).
  syncConfig(config) {
    this.config = mergeConfig(config, this.config);
    this.speakerEl.textContent = this.config.persona.speakerName;
    this.compactSpeakerEl.textContent = this.config.persona.speakerName;
    document.body.dataset.companionTheme = this.config.ui.theme;
    this.setChatDisplayMode(this.config.ui.chatDisplayModeDefault || this.chatDisplayMode, { silent: true });
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
      const markUnread = this.chatDisplayMode === 'collapsed' || meta.source === 'timer';
      this.setLiveUtterance(content, { unread: markUnread, source: meta.source || 'assistant' });
    }
  }

  setLiveUtterance(content, options = {}) {
    this.liveUtterance = content || '等待她开口...';
    this.hasUnreadUtterance = Boolean(options.unread);
    this.liveBannerEl.textContent = this.liveUtterance;
    this.liveUtteranceEl.textContent = this.liveUtterance;
    this.root.classList.toggle('has-unread-utterance', this.hasUnreadUtterance);
  }

  setChatDisplayMode(mode, options = {}) {
    const nextMode = mode === 'collapsed' ? 'collapsed' : 'expanded';
    this.chatDisplayMode = nextMode;
    this.root.dataset.chatDisplayMode = nextMode;

    if (nextMode === 'expanded') {
      this.hasUnreadUtterance = false;
      this.root.classList.remove('has-unread-utterance');
    }

    if (!options.silent) {
      // Persist just the display-mode preference through the shared config path.
      this.onConfigChange({ ui: { chatDisplayModeDefault: nextMode } });
    }
  }

  isCollapsed() {
    return this.chatDisplayMode === 'collapsed';
  }

  setBusy(isBusy, detail = 'idle') {
    this.busyEl.textContent = `状态: ${detail}`;
    this.root.classList.toggle('is-busy', isBusy);
  }

  setConnectionStatus(text, kind = 'neutral') {
    this.connectionEl.textContent = text;
    this.connectionEl.dataset.kind = kind;
  }

  setTimerCountdown(seconds) {
    if (!Number.isFinite(seconds)) {
      this.timerEl.textContent = '下一次主动发言: --';
      this.compactTimerEl.textContent = '下一次主动发言: --';
      return;
    }
    const text = `下一次主动发言: ${Math.max(0, Math.ceil(seconds))}s`;
    this.timerEl.textContent = text;
    this.compactTimerEl.textContent = text;
  }

  setMemoryStats(stats) {
    this.memoryStatsEl.textContent = `最近 ${stats.recentCount} 条消息 · ${stats.diaryCount} 条关系记忆 · 已累积 ${stats.turnsSinceCompress} 条新轮次`;
  }
}

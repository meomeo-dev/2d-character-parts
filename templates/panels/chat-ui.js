import { CONFIG_LIMITS, mergeConfig, sanitizeConfigForExport } from './default-config.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function downloadJson(fileName, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function createFieldRow(label, inputHtml, hint = '') {
  return `
    <label class="companion-field">
      <span class="companion-field-label">${label}</span>
      ${inputHtml}
      ${hint ? `<span class="companion-field-hint">${hint}</span>` : ''}
    </label>
  `;
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
    this.onConfigChange = onConfigChange;
    this.onConnectionRefresh = onConnectionRefresh;
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
      <button id="companion-settings-toggle" class="companion-settings-toggle">Companion</button>
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
      <aside id="companion-settings" class="companion-settings">
        <div class="companion-settings-header">
          <div>
            <div class="companion-settings-kicker">AI Companion</div>
            <h2>设置面板 Settings</h2>
          </div>
          <button id="companion-close-settings" class="companion-icon-btn" type="button">×</button>
        </div>
        <div class="companion-settings-body">
          <section class="companion-settings-group">
            <h3>Persona</h3>
            ${createFieldRow('称呼 Speaker Name', '<input id="speaker-name" type="text" maxlength="40" />')}
            ${createFieldRow('系统提示词 System Prompt', '<textarea id="system-prompt" rows="6"></textarea>')}
            ${createFieldRow('记忆压缩提示词 Diary Prompt', '<textarea id="diary-prompt" rows="5"></textarea>', '建议写成结构化、温柔但克制的关系日记提示。')}
          </section>
          <section class="companion-settings-group">
            <h3>Schedule</h3>
            ${createFieldRow('开启定时发言 Auto Speak', '<input id="schedule-enabled" type="checkbox" />')}
            ${createFieldRow('首次发言 Initial Delay (sec)', `<input id="initial-auto-delay" type="number" min="${CONFIG_LIMITS.initialAutoSpeakDelaySec.min}" max="${CONFIG_LIMITS.initialAutoSpeakDelaySec.max}" step="${CONFIG_LIMITS.initialAutoSpeakDelaySec.step}" />`, '首次打开页面后，多久开始第一次主动发言。')}
            ${createFieldRow('说话频率 Interval (sec)', `<input id="speaking-interval" type="number" min="${CONFIG_LIMITS.speakingIntervalSec.min}" max="${CONFIG_LIMITS.speakingIntervalSec.max}" step="${CONFIG_LIMITS.speakingIntervalSec.step}" />`)}
            ${createFieldRow('静默缓冲 Idle Grace (sec)', `<input id="idle-grace" type="number" min="${CONFIG_LIMITS.idleGraceSec.min}" max="${CONFIG_LIMITS.idleGraceSec.max}" step="${CONFIG_LIMITS.idleGraceSec.step}" />`)}
          </section>
          <section class="companion-settings-group">
            <h3>Memory</h3>
            ${createFieldRow('原始记忆长度 Recent Turns', `<input id="recent-limit" type="number" min="${CONFIG_LIMITS.recentMessageLimit.min}" max="${CONFIG_LIMITS.recentMessageLimit.max}" step="${CONFIG_LIMITS.recentMessageLimit.step}" />`)}
            ${createFieldRow('压缩频次 Compress Every Turns', `<input id="compress-every" type="number" min="${CONFIG_LIMITS.compressEveryTurns.min}" max="${CONFIG_LIMITS.compressEveryTurns.max}" step="${CONFIG_LIMITS.compressEveryTurns.step}" />`)}
            ${createFieldRow('压缩后保留轮数 Keep Turns After Compress', `<input id="keep-turns" type="number" min="${CONFIG_LIMITS.keepTurnsAfterCompress.min}" max="${CONFIG_LIMITS.keepTurnsAfterCompress.max}" step="${CONFIG_LIMITS.keepTurnsAfterCompress.step}" />`)}
            <div id="memory-stats" class="companion-memory-stats">最近 0 条消息 · 0 条关系记忆</div>
          </section>
          <section class="companion-settings-group">
            <h3>Motion (2D)</h3>
            ${createFieldRow('自动动作 Auto Gesture', '<input id="auto-gesture" type="checkbox" />', '开启后模型可调用动作工具，并在回复后播放轻量兜底动作。')}
            ${createFieldRow('动作冷却 Gesture Cooldown (ms)', '<input id="gesture-cooldown" type="number" min="0" max="20000" step="100" />')}
            ${createFieldRow('默认待机 Idle Clip', '<select id="default-idle"><option value="idle">idle</option><option value="none">none</option></select>')}
          </section>
          <section class="companion-settings-group">
            <h3>Theme</h3>
            ${createFieldRow('主题 Theme', '<select id="ui-theme"><option value="ocean-console">ocean-console</option><option value="midnight-glass">midnight-glass</option></select>')}
          </section>
          <section class="companion-settings-group">
            <h3>Connection</h3>
            ${createFieldRow('代理路径 Proxy Base', '<input id="proxy-base" type="text" placeholder="/api" />', '通常保持 /api 即可。')}
            ${createFieldRow('模型 Model', '<input id="model-name" type="text" placeholder="provider/model" />', 'provider/model 形式，留空则用服务端配置。')}
            <button id="refresh-health" class="companion-secondary-btn" type="button">刷新连接状态</button>
            <div id="connection-status" class="companion-connection-status">等待连接...</div>
          </section>
          <section class="companion-settings-group">
            <h3>Export</h3>
            <div class="companion-actions-row">
              <button id="export-config" class="companion-primary-btn" type="button">导出配置 Export</button>
            </div>
          </section>
        </div>
      </aside>
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
            </div>
            <div class="companion-chat-actions">
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
    this.settingsEl = root.querySelector('#companion-settings');
    this.chatEl = root.querySelector('#companion-chat');
    this.compactEl = root.querySelector('#companion-compact');

    this.form = root.querySelector('#companion-input-form');
    this.input = root.querySelector('#companion-input');

    this.fieldMap = {
      speakerName: root.querySelector('#speaker-name'),
      systemPrompt: root.querySelector('#system-prompt'),
      diaryPrompt: root.querySelector('#diary-prompt'),
      scheduleEnabled: root.querySelector('#schedule-enabled'),
      initialAutoSpeakDelaySec: root.querySelector('#initial-auto-delay'),
      speakingIntervalSec: root.querySelector('#speaking-interval'),
      idleGraceSec: root.querySelector('#idle-grace'),
      recentMessageLimit: root.querySelector('#recent-limit'),
      compressEveryTurns: root.querySelector('#compress-every'),
      keepTurnsAfterCompress: root.querySelector('#keep-turns'),
      enableAutoGesture: root.querySelector('#auto-gesture'),
      autoGestureCooldownMs: root.querySelector('#gesture-cooldown'),
      defaultIdle: root.querySelector('#default-idle'),
      theme: root.querySelector('#ui-theme'),
      proxyBase: root.querySelector('#proxy-base'),
      model: root.querySelector('#model-name'),
    };

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

    root.querySelector('#refresh-health').addEventListener('click', () => this.onConnectionRefresh());
    root.querySelector('#export-config').addEventListener('click', () => {
      downloadJson('studio-companion-config.json', sanitizeConfigForExport(this.config));
    });
    root.querySelector('#companion-settings-toggle').addEventListener('click', () => {
      this.settingsEl.classList.toggle('is-open');
    });
    root.querySelector('#companion-expand-chat').addEventListener('click', () => {
      this.setChatDisplayMode('expanded');
    });
    root.querySelector('#companion-collapse-chat').addEventListener('click', () => {
      this.setChatDisplayMode('collapsed');
    });
    root.querySelector('#companion-close-settings').addEventListener('click', () => {
      this.settingsEl.classList.remove('is-open');
    });

    Object.values(this.fieldMap).forEach((field) => {
      field.addEventListener('change', () => this.#collectConfig());
      if (field.tagName === 'TEXTAREA' || field.type === 'text' || field.type === 'number') {
        field.addEventListener('input', () => this.#collectConfig());
      }
    });
  }

  #collectConfig() {
    this.config = mergeConfig(
      {
        api: {
          proxyBase: this.fieldMap.proxyBase.value || '/api',
          model: this.fieldMap.model.value,
        },
        persona: {
          speakerName: this.fieldMap.speakerName.value,
          systemPrompt: this.fieldMap.systemPrompt.value,
          diaryPrompt: this.fieldMap.diaryPrompt.value,
        },
        schedule: {
          enabled: this.fieldMap.scheduleEnabled.checked,
          initialAutoSpeakDelaySec: Number(this.fieldMap.initialAutoSpeakDelaySec.value),
          speakingIntervalSec: Number(this.fieldMap.speakingIntervalSec.value),
          idleGraceSec: Number(this.fieldMap.idleGraceSec.value),
        },
        memory: {
          recentMessageLimit: Number(this.fieldMap.recentMessageLimit.value),
          compressEveryTurns: Number(this.fieldMap.compressEveryTurns.value),
          keepTurnsAfterCompress: Number(this.fieldMap.keepTurnsAfterCompress.value),
        },
        motion: {
          enableAutoGesture: this.fieldMap.enableAutoGesture.checked,
          autoGestureCooldownMs: Number(this.fieldMap.autoGestureCooldownMs.value),
          defaultIdle: this.fieldMap.defaultIdle.value,
        },
        ui: {
          theme: this.fieldMap.theme.value,
          chatDisplayModeDefault: this.chatDisplayMode,
        },
      },
      this.config,
    );
    this.onConfigChange(this.config);
    this.speakerEl.textContent = this.config.persona.speakerName;
    this.compactSpeakerEl.textContent = this.config.persona.speakerName;
    document.body.dataset.companionTheme = this.config.ui.theme;
  }

  syncConfig(config) {
    this.config = mergeConfig(config, this.config);
    this.fieldMap.speakerName.value = this.config.persona.speakerName;
    this.fieldMap.systemPrompt.value = this.config.persona.systemPrompt;
    this.fieldMap.diaryPrompt.value = this.config.persona.diaryPrompt;
    this.fieldMap.scheduleEnabled.checked = this.config.schedule.enabled;
    this.fieldMap.initialAutoSpeakDelaySec.value = this.config.schedule.initialAutoSpeakDelaySec;
    this.fieldMap.speakingIntervalSec.value = this.config.schedule.speakingIntervalSec;
    this.fieldMap.idleGraceSec.value = this.config.schedule.idleGraceSec;
    this.fieldMap.recentMessageLimit.value = this.config.memory.recentMessageLimit;
    this.fieldMap.compressEveryTurns.value = this.config.memory.compressEveryTurns;
    this.fieldMap.keepTurnsAfterCompress.value = this.config.memory.keepTurnsAfterCompress;
    this.fieldMap.enableAutoGesture.checked = this.config.motion.enableAutoGesture;
    this.fieldMap.autoGestureCooldownMs.value = this.config.motion.autoGestureCooldownMs;
    this.fieldMap.defaultIdle.value = this.config.motion.defaultIdle;
    this.fieldMap.theme.value = this.config.ui.theme;
    this.fieldMap.proxyBase.value = this.config.api.proxyBase;
    this.fieldMap.model.value = this.config.api.model;
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
      this.#collectConfig();
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

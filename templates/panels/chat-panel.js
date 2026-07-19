// Chat companion panel entry point.
//
// Wires MemoryEngine + CompanionUI + LlmClient + Sprite2DController together and
// ports the original HTML orchestration (requestAssistantTurn / maybeCompressMemory
// / the 1s auto-speak timer / markConversationActivity) into #chat-panel. Adds the
// persistence the original lacked: config + memory are saved to localStorage under
// `studio_chat_v1` and restored on load.
import { CompanionUI } from './chat-ui.js';
import { CONFIG_LIMITS, mergeConfig, sanitizeConfigForExport } from './default-config.js';
import { LlmClient } from './llm-client.js';
import { MemoryEngine } from './memory-engine.js';
import { Sprite2DController } from './sprite2d-controller.js';

const STORAGE_KEY = 'studio_chat_v1';
let mounted = false;

function downloadJson(fileName, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

// The lil-gui ⚙ Settings panel is built by the classic inline script in
// studio.html and exposed as window.GUI_PANEL. It may not exist yet when this
// module mounts, so poll briefly before injecting the companion folder.
function whenGuiReady(callback, tries = 40) {
  if (window.GUI_PANEL && window.GUI_PANEL.addFolder) {
    callback(window.GUI_PANEL);
    return;
  }
  if (tries <= 0) {
    return;
  }
  window.setTimeout(() => whenGuiReady(callback, tries - 1), 50);
}

// Build the "💬 Chat / Companion" folder inside the shared ⚙ Settings panel.
// getConfig() returns the live config; applyPatch(partial) merges + persists it.
function buildCompanionSettings(gui, getConfig, applyPatch) {
  const cfg = getConfig();
  const state = {
    speakerName: cfg.persona.speakerName,
    systemPrompt: cfg.persona.systemPrompt,
    diaryPrompt: cfg.persona.diaryPrompt,
    scheduleEnabled: cfg.schedule.enabled,
    initialAutoSpeakDelaySec: cfg.schedule.initialAutoSpeakDelaySec,
    speakingIntervalSec: cfg.schedule.speakingIntervalSec,
    idleGraceSec: cfg.schedule.idleGraceSec,
    recentMessageLimit: cfg.memory.recentMessageLimit,
    compressEveryTurns: cfg.memory.compressEveryTurns,
    keepTurnsAfterCompress: cfg.memory.keepTurnsAfterCompress,
    enableAutoGesture: cfg.motion.enableAutoGesture,
    autoGestureCooldownMs: cfg.motion.autoGestureCooldownMs,
    defaultIdle: cfg.motion.defaultIdle,
    theme: cfg.ui.theme,
  };
  const emit = () =>
    applyPatch({
      persona: { speakerName: state.speakerName, systemPrompt: state.systemPrompt, diaryPrompt: state.diaryPrompt },
      schedule: {
        enabled: state.scheduleEnabled,
        initialAutoSpeakDelaySec: Number(state.initialAutoSpeakDelaySec),
        speakingIntervalSec: Number(state.speakingIntervalSec),
        idleGraceSec: Number(state.idleGraceSec),
      },
      memory: {
        recentMessageLimit: Number(state.recentMessageLimit),
        compressEveryTurns: Number(state.compressEveryTurns),
        keepTurnsAfterCompress: Number(state.keepTurnsAfterCompress),
      },
      motion: {
        enableAutoGesture: state.enableAutoGesture,
        autoGestureCooldownMs: Number(state.autoGestureCooldownMs),
        defaultIdle: state.defaultIdle,
      },
      ui: { theme: state.theme },
    });

  const lim = CONFIG_LIMITS;
  const f = gui.addFolder('💬 Chat / Companion');

  const persona = f.addFolder('Persona');
  persona.add(state, 'speakerName').name('称呼 Speaker').onFinishChange(emit);
  persona.add(state, 'systemPrompt').name('System Prompt').onFinishChange(emit);
  persona.add(state, 'diaryPrompt').name('Diary Prompt').onFinishChange(emit);

  const sched = f.addFolder('Schedule');
  sched.add(state, 'scheduleEnabled').name('Auto Speak').onChange(emit);
  sched.add(state, 'initialAutoSpeakDelaySec', lim.initialAutoSpeakDelaySec.min, lim.initialAutoSpeakDelaySec.max, lim.initialAutoSpeakDelaySec.step).name('Initial Delay (s)').onChange(emit);
  sched.add(state, 'speakingIntervalSec', lim.speakingIntervalSec.min, lim.speakingIntervalSec.max, lim.speakingIntervalSec.step).name('Interval (s)').onChange(emit);
  sched.add(state, 'idleGraceSec', lim.idleGraceSec.min, lim.idleGraceSec.max, lim.idleGraceSec.step).name('Idle Grace (s)').onChange(emit);

  const mem = f.addFolder('Memory');
  mem.add(state, 'recentMessageLimit', lim.recentMessageLimit.min, lim.recentMessageLimit.max, lim.recentMessageLimit.step).name('Recent Turns').onChange(emit);
  mem.add(state, 'compressEveryTurns', lim.compressEveryTurns.min, lim.compressEveryTurns.max, lim.compressEveryTurns.step).name('Compress Every').onChange(emit);
  mem.add(state, 'keepTurnsAfterCompress', lim.keepTurnsAfterCompress.min, lim.keepTurnsAfterCompress.max, lim.keepTurnsAfterCompress.step).name('Keep After Compress').onChange(emit);

  const motion = f.addFolder('Motion (2D)');
  motion.add(state, 'enableAutoGesture').name('Auto Gesture').onChange(emit);
  motion.add(state, 'autoGestureCooldownMs', 0, 20000, 100).name('Gesture Cooldown (ms)').onChange(emit);
  motion.add(state, 'defaultIdle', ['idle', 'none']).name('Idle Clip').onChange(emit);

  f.addFolder('Theme').add(state, 'theme', ['ocean-console', 'midnight-glass']).name('Theme').onChange(emit);

  f.add({ export: () => downloadJson('studio-companion-config.json', sanitizeConfigForExport(getConfig())) }, 'export').name('导出配置 Export');
  f.close();
}

function injectStylesheet() {
  const href = new URL('./companion-ui.css', import.meta.url).href;
  if (document.querySelector(`link[data-companion-css]`)) {
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.companionCss = '1';
  document.head.appendChild(link);
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function mount() {
  const container = document.getElementById('chat-panel');
  if (!container || mounted) {
    return;
  }
  mounted = true;
  injectStylesheet();

  const persisted = loadPersisted();
  let companionConfig = mergeConfig(persisted.config || {});

  const client = new LlmClient(companionConfig.api.proxyBase);
  const memoryEngine = new MemoryEngine(companionConfig);
  if (persisted.memory) {
    memoryEngine.importState(persisted.memory);
  }

  const stage = document.createElement('div');
  stage.className = 'sprite2d-stage';
  container.appendChild(stage);
  const sprite = new Sprite2DController(stage, { animationsUrl: '/api/animations' });
  sprite.setConfig(companionConfig);

  let companionUI = null;
  let assistantBusy = false;
  let lastConversationActivityAt = Date.now();
  let nextAutoSpeakAt = Date.now() + companionConfig.schedule.initialAutoSpeakDelaySec * 1000;

  const logDebug = (message) => console.debug(`[companion] ${message}`);

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          config: sanitizeConfigForExport(companionConfig),
          memory: memoryEngine.exportState(),
        }),
      );
    } catch {
      // storage may be unavailable (private mode / quota) — persistence is best-effort.
    }
  }

  function buildSceneContext() {
    return {
      surface: '2d-sprite-studio',
      hasSprite: true,
      currentExpression: sprite.currentExpression,
      autoGestureEnabled: companionConfig.motion.enableAutoGesture,
    };
  }

  function updateMemoryStats() {
    if (companionUI) {
      companionUI.setMemoryStats(memoryEngine.getStats());
    }
  }

  function scheduleNextAutoSpeech(delaySeconds = companionConfig.schedule.speakingIntervalSec) {
    nextAutoSpeakAt = Date.now() + Math.max(1, delaySeconds) * 1000;
  }

  function markConversationActivity(reason, options = {}) {
    lastConversationActivityAt = Date.now();
    if (options.reschedule) {
      scheduleNextAutoSpeech(options.delaySeconds || companionConfig.schedule.speakingIntervalSec);
    }
    if (reason && options.log) {
      logDebug(`activity: ${reason}`);
    }
  }

  function setAssistantBusy(isBusy, detail) {
    assistantBusy = isBusy;
    if (companionUI) {
      companionUI.setBusy(isBusy, detail);
    }
  }

  async function refreshHealth() {
    if (!companionUI) {
      return;
    }
    try {
      const health = await client.checkHealth();
      companionUI.setConnectionStatus(
        health.apiKeyConfigured ? '代理在线，已检测到 API Key。' : '代理在线，但未检测到 API Key。',
        health.apiKeyConfigured ? 'ok' : 'error',
      );
    } catch (error) {
      companionUI.setConnectionStatus(`代理不可用: ${error.message}`, 'error');
    }
  }

  async function maybeCompressMemory() {
    if (!memoryEngine.shouldCompress()) {
      updateMemoryStats();
      return;
    }
    setAssistantBusy(true, 'compressing-memory');
    try {
      const state = memoryEngine.exportState();
      const result = await client.compress({
        recentMessages: state.recentMessages,
        relationshipDiary: state.relationshipDiary,
        config: companionConfig,
      });
      if (result.summary) {
        memoryEngine.applyCompression(result.summary, result.stableProfilePatch || {});
        logDebug('relationship memory compressed');
      }
    } catch (error) {
      logDebug(`memory compression failed: ${error.message}`);
    } finally {
      setAssistantBusy(false, 'idle');
      updateMemoryStats();
      save();
    }
  }

  async function requestAssistantTurn(mode, userMessage = '') {
    if (assistantBusy) {
      return;
    }

    if (userMessage) {
      memoryEngine.addMessage('user', userMessage, { mode });
      companionUI.appendMessage('user', userMessage);
      markConversationActivity('user-send', { log: true });
      sprite.noteUserEngagement();
      updateMemoryStats();
    }

    setAssistantBusy(true, mode === 'timer' ? 'auto-speaking' : 'thinking');
    sprite.beginThinking(mode);

    try {
      const state = memoryEngine.exportState();
      const result = await client.chat({
        mode,
        userMessage,
        recentMessages: state.recentMessages,
        relationshipDiary: state.relationshipDiary,
        stableProfile: state.stableProfile,
        sceneContext: buildSceneContext(),
        config: companionConfig,
      });

      if (result.assistantMessage) {
        memoryEngine.addMessage('assistant', result.assistantMessage, { mode, usage: result.usage || null });
        companionUI.appendMessage('assistant', result.assistantMessage, { source: mode });
        markConversationActivity(mode === 'timer' ? 'assistant-auto' : 'assistant-reply', { log: true });
      }

      const hasEffects = Array.isArray(result.effects) && result.effects.length > 0;
      if (hasEffects) {
        sprite.applyEffects(result.effects);
      }

      sprite.reactToAssistantReply({
        mode,
        text: result.assistantMessage || '',
        usedToolEffects: hasEffects,
      });

      await maybeCompressMemory();
      save();
    } catch (error) {
      logDebug(`chat request failed: ${error.message}`);
      companionUI.appendMessage('assistant', `连接失败: ${error.message}`);
      scheduleNextAutoSpeech(Math.min(30, companionConfig.schedule.speakingIntervalSec));
    } finally {
      setAssistantBusy(false, 'idle');
    }
  }

  function handleConfigChange(nextConfig) {
    companionConfig = mergeConfig(nextConfig, companionConfig);
    client.setBasePath(companionConfig.api.proxyBase);
    memoryEngine.setConfig(companionConfig);
    sprite.setConfig(companionConfig);
    if (companionUI) {
      companionUI.syncConfig(companionConfig);
    }
    if (!companionConfig.schedule.enabled) {
      companionUI.setTimerCountdown(Number.NaN);
    } else if (!Number.isFinite(nextAutoSpeakAt) || nextAutoSpeakAt <= Date.now()) {
      scheduleNextAutoSpeech(companionConfig.schedule.initialAutoSpeakDelaySec);
    }
    refreshHealth();
    updateMemoryStats();
    save();
  }

  companionUI = new CompanionUI({
    config: companionConfig,
    onSend: (message) => requestAssistantTurn('user', message),
    onConfigChange: handleConfigChange,
    onConnectionRefresh: refreshHealth,
    onConversationActivity: (reason) => markConversationActivity(`ui-${reason}`),
    mountTarget: container,
  });

  // Replay any persisted conversation so history survives reloads.
  memoryEngine.recentMessages.forEach((message) => {
    if (message.role === 'user' || message.role === 'assistant') {
      companionUI.appendMessage(message.role, message.content, message.meta || {});
    }
  });

  updateMemoryStats();
  refreshHealth();

  // Merge companion config editing into the shared ⚙ Settings panel.
  whenGuiReady((gui) => buildCompanionSettings(gui, () => companionConfig, handleConfigChange));

  window.setInterval(() => {
    const secondsUntilSpeak = (nextAutoSpeakAt - Date.now()) / 1000;
    companionUI.setTimerCountdown(companionConfig.schedule.enabled ? secondsUntilSpeak : Number.NaN);

    if (!companionConfig.schedule.enabled || assistantBusy) {
      return;
    }

    const idleSeconds = (Date.now() - lastConversationActivityAt) / 1000;
    if (idleSeconds < companionConfig.schedule.idleGraceSec) {
      return;
    }

    if (secondsUntilSpeak <= 0) {
      requestAssistantTurn('timer');
    }
  }, 1000);

  // Lightweight animation tick so the sprite can revert to idle after a gesture.
  let lastTick = performance.now();
  function tick(now) {
    sprite.update((now - lastTick) / 1000);
    lastTick = now;
    window.requestAnimationFrame(tick);
  }
  window.requestAnimationFrame(tick);
}

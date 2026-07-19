// Chat companion panel entry point.
//
// Wires MemoryEngine + CompanionUI + LlmClient + Sprite2DController together and
// ports the original HTML orchestration (requestAssistantTurn / maybeCompressMemory
// / the 1s auto-speak timer / markConversationActivity) into #chat-panel. Adds the
// persistence the original lacked: config + memory are saved to localStorage under
// `studio_chat_v1` and restored on load.
import { CompanionUI } from './chat-ui.js';
import { mergeConfig, sanitizeConfigForExport } from './default-config.js';
import { LlmClient } from './llm-client.js';
import { MemoryEngine } from './memory-engine.js';
import { Sprite2DController } from './sprite2d-controller.js';

const STORAGE_KEY = 'studio_chat_v1';
let mounted = false;

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

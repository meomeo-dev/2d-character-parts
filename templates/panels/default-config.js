// Default companion configuration for the 2D sprite studio.
//
// Adapted from the original VRM companion config:
//   * api.model now carries provider/model semantics (e.g. "openai/gpt-5.5")
//     resolved server-side via providers.get_llm(); the DeepSeek-specific
//     thinkingMode toggle is dropped.
//   * motion.* is redefined for a flat 2D sprite (no head look-at / VRM idle);
//     defaultIdle is a clip name and autoGestureCooldownMs throttles fallback
//     gestures.
export const DEFAULT_CONFIG = {
  api: {
    proxyBase: '/api',
    // provider/model form, e.g. "openai/gpt-5.5"; empty falls back to server settings.
    model: 'openai/gpt-5.5',
  },
  persona: {
    speakerName: '元気少女',
    systemPrompt: '你是一位温柔、坦率、不过度黏人的虚拟陪伴者。你会结合最近对话、关系记忆与当前场景，自然地回应用户。若合适，可以调用动作工具让表达更有生命感。避免说教、避免空泛夸奖、避免连续重复类似句式。',
    diaryPrompt: '请把长期关系记忆整理成像少女日记一样温柔、细腻、克制的结构化摘要。先写事实，再写情感温度，再写下一次适合主动提起的话题。所有不确定内容必须标记为 tentative。',
  },
  schedule: {
    enabled: true,
    initialAutoSpeakDelaySec: 18,
    speakingIntervalSec: 90,
    idleGraceSec: 20,
  },
  memory: {
    recentMessageLimit: 12,
    compressEveryTurns: 8,
    keepTurnsAfterCompress: 4,
  },
  motion: {
    // Whether the model may call motion tools and the sprite plays fallback gestures.
    enableAutoGesture: true,
    // Minimum gap between auto/fallback gestures, in milliseconds.
    autoGestureCooldownMs: 2800,
    // Clip name to rest on between gestures ('none' shows a static placeholder).
    defaultIdle: 'idle',
  },
  ui: {
    theme: 'ocean-console',
    chatDisplayModeDefault: 'expanded',
  },
};

export const CONFIG_LIMITS = {
  initialAutoSpeakDelaySec: { min: 5, max: 120, step: 1 },
  speakingIntervalSec: { min: 15, max: 600, step: 1 },
  idleGraceSec: { min: 5, max: 120, step: 1 },
  recentMessageLimit: { min: 4, max: 40, step: 1 },
  compressEveryTurns: { min: 4, max: 30, step: 1 },
  keepTurnsAfterCompress: { min: 2, max: 12, step: 1 },
};

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeObjects(base, overrides) {
  const output = Array.isArray(base) ? [...base] : { ...base };

  Object.entries(overrides || {}).forEach(([key, value]) => {
    if (isPlainObject(value) && isPlainObject(base?.[key])) {
      output[key] = mergeObjects(base[key], value);
      return;
    }
    output[key] = deepClone(value);
  });

  return output;
}

function clamp(value, limits) {
  return Math.min(limits.max, Math.max(limits.min, value));
}

export function mergeConfig(overrides = {}, base = DEFAULT_CONFIG) {
  const merged = mergeObjects(deepClone(base), overrides);

  merged.schedule.initialAutoSpeakDelaySec = clamp(
    Number(merged.schedule.initialAutoSpeakDelaySec),
    CONFIG_LIMITS.initialAutoSpeakDelaySec,
  );
  merged.schedule.speakingIntervalSec = clamp(
    Number(merged.schedule.speakingIntervalSec),
    CONFIG_LIMITS.speakingIntervalSec,
  );
  merged.schedule.idleGraceSec = clamp(
    Number(merged.schedule.idleGraceSec),
    CONFIG_LIMITS.idleGraceSec,
  );
  merged.memory.recentMessageLimit = clamp(
    Number(merged.memory.recentMessageLimit),
    CONFIG_LIMITS.recentMessageLimit,
  );
  merged.memory.compressEveryTurns = clamp(
    Number(merged.memory.compressEveryTurns),
    CONFIG_LIMITS.compressEveryTurns,
  );
  merged.memory.keepTurnsAfterCompress = clamp(
    Number(merged.memory.keepTurnsAfterCompress),
    CONFIG_LIMITS.keepTurnsAfterCompress,
  );

  return merged;
}

export function sanitizeConfigForExport(config) {
  return mergeConfig({
    api: {
      proxyBase: config.api.proxyBase,
      model: config.api.model,
    },
    persona: {
      speakerName: config.persona.speakerName,
      systemPrompt: config.persona.systemPrompt,
      diaryPrompt: config.persona.diaryPrompt,
    },
    schedule: config.schedule,
    memory: config.memory,
    motion: config.motion,
    ui: config.ui,
  });
}

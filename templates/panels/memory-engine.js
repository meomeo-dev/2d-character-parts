import { mergeConfig } from './default-config.js';

export class MemoryEngine {
  constructor(config) {
    this.config = mergeConfig(config || {});
    this.recentMessages = [];
    this.relationshipDiary = [];
    this.stableProfile = {
      preferredName: null,
      preferences: [],
      boundaries: [],
    };
    this.turnsSinceCompress = 0;
  }

  setConfig(config) {
    this.config = mergeConfig(config, this.config);
    this.#trimRecentMessages();
  }

  addMessage(role, content, meta = {}) {
    this.recentMessages.push({
      role,
      content,
      meta,
      createdAt: new Date().toISOString(),
    });
    this.#trimRecentMessages();
    if (role === 'user' || role === 'assistant') {
      this.turnsSinceCompress += 1;
    }
  }

  addDiaryEntry(entry) {
    this.relationshipDiary.unshift(entry);
    this.relationshipDiary = this.relationshipDiary.slice(0, 6);
  }

  applyStableProfilePatch(patch = {}) {
    if (!patch || typeof patch !== 'object') {
      return;
    }

    const nextProfile = { ...this.stableProfile };

    Object.entries(patch).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        const existingValues = Array.isArray(nextProfile[key]) ? nextProfile[key] : [];
        nextProfile[key] = [...new Set([...existingValues, ...value])];
        return;
      }

      if (value !== null && value !== undefined && value !== '') {
        nextProfile[key] = value;
      }
    });

    this.stableProfile = nextProfile;
  }

  shouldCompress() {
    return this.turnsSinceCompress >= this.config.memory.compressEveryTurns;
  }

  applyCompression(summary, stableProfilePatch = {}) {
    this.addDiaryEntry(summary);
    this.applyStableProfilePatch(stableProfilePatch);
    const keepCount = this.config.memory.keepTurnsAfterCompress * 2;
    this.recentMessages = this.recentMessages.slice(-keepCount);
    this.turnsSinceCompress = 0;
  }

  buildChatPayload(mode, userMessage, extra = {}) {
    return {
      mode,
      userMessage,
      recentMessages: this.recentMessages,
      relationshipDiary: this.relationshipDiary,
      stableProfile: this.stableProfile,
      ...extra,
    };
  }

  exportState() {
    return {
      recentMessages: this.recentMessages,
      relationshipDiary: this.relationshipDiary,
      stableProfile: this.stableProfile,
      turnsSinceCompress: this.turnsSinceCompress,
    };
  }

  // Restore a previously exported state (used for localStorage persistence).
  importState(state = {}) {
    if (!state || typeof state !== 'object') {
      return;
    }
    if (Array.isArray(state.recentMessages)) {
      this.recentMessages = state.recentMessages;
    }
    if (Array.isArray(state.relationshipDiary)) {
      this.relationshipDiary = state.relationshipDiary;
    }
    if (state.stableProfile && typeof state.stableProfile === 'object') {
      this.stableProfile = { ...this.stableProfile, ...state.stableProfile };
    }
    if (Number.isFinite(state.turnsSinceCompress)) {
      this.turnsSinceCompress = state.turnsSinceCompress;
    }
    this.#trimRecentMessages();
  }

  getStats() {
    return {
      recentCount: this.recentMessages.length,
      diaryCount: this.relationshipDiary.length,
      turnsSinceCompress: this.turnsSinceCompress,
    };
  }

  #trimRecentMessages() {
    const maxMessages = this.config.memory.recentMessageLimit * 2;
    this.recentMessages = this.recentMessages.slice(-maxMessages);
  }
}

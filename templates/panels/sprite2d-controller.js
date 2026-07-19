// 2D sprite motion/expression controller.
//
// Public surface mirrors the original VRM motion-controller so the chat
// orchestration is unchanged: applyEffects / playMotion / stopMotion /
// setExpression / noteUserEngagement / beginThinking / reactToAssistantReply /
// setConfig / update. All 3D/camera concepts (head_look_at, bones, look-at)
// are removed — motions map to animation GIF clips fetched from /api/animations
// and expressions map to a lightweight face badge.

// Free-form clip-name aliases: friendly LLM names -> canonical clip names.
const MOTION_ALIASES = {
  hi: 'wave',
  hello: 'wave',
  greet: 'wave',
  agree: 'nod',
  yes: 'nod',
  thinking: 'think',
  ponder: 'think',
  smile: 'happy',
  cheer: 'happy',
  rest: 'idle',
  stop: 'idle',
};

const EXPRESSION_EMOJI = {
  happy: '😊',
  relaxed: '😌',
  surprised: '😮',
  blink: '😉',
  neutral: '🙂',
};

export class Sprite2DController {
  constructor(stageEl, options = {}) {
    this.stage = stageEl || null;
    this.config = null;
    this.animationsUrl = options.animationsUrl || '/api/animations';
    this.clips = null; // { lowercasedName: gifUrl }
    this.currentMotion = null;
    this.currentExpression = 'neutral';
    this.motionEndsAt = Infinity;
    this.lastAutoGestureAt = 0;
    this.state = 'idle';
    this.#buildDom();
  }

  setConfig(config) {
    this.config = config;
  }

  /**
   * Drop the cached clip index so the next playMotion / start re-fetches from
   * the server. Call this after new animations are generated elsewhere (the
   * Sprite Animation panel) so freshly-created clips become playable without a
   * full page reload. Optionally re-fetches immediately when `reload` is true.
   */
  async refreshClips({ reload = false } = {}) {
    this.clips = null;
    if (reload) {
      await this.#loadClips();
    }
  }

  /**
   * Kick off the initial animation after mount. Loads the clip index and plays
   * the default idle clip so a freshly-loaded / refreshed page shows the looping
   * GIF instead of sitting on the "⟨ idle ⟩" placeholder. Safe to call once the
   * controller is constructed (config optional; falls back to 'idle').
   */
  async start() {
    await this.#loadClips();
    this.#goIdle();
  }

  // --- effect application (mirrors motion-controller switch) ---

  applyEffects(effects = []) {
    effects.forEach((effect) => {
      switch (effect.type) {
        case 'motion_play':
          this.playMotion(effect.name, effect);
          break;
        case 'motion_stop':
          this.stopMotion(effect.name);
          break;
        case 'face_set':
          this.setExpression(effect.expression, effect.weight, effect.duration);
          break;
        default:
          break;
      }
    });
  }

  async playMotion(name, options = {}) {
    const clips = await this.#loadClips();
    const key = this.#resolveClipName(name, clips);

    if (key && clips[key]) {
      this.#showGif(clips[key]);
      this.currentMotion = key;
    } else {
      this.#showPlaceholder(name);
      this.currentMotion = key || null;
    }

    const isIdle = key === (this.config?.motion?.defaultIdle || 'idle');
    if (options.loop || isIdle) {
      this.motionEndsAt = Infinity;
    } else {
      const duration = Number(options.duration) || 1.2;
      this.motionEndsAt = Date.now() + duration * 1000;
    }
    return Boolean(key && clips[key]);
  }

  stopMotion() {
    this.#goIdle();
  }

  setExpression(expression, weight = 0.5, _duration = 0.25) {
    this.currentExpression = EXPRESSION_EMOJI[expression] ? expression : 'neutral';
    if (this.stage) {
      this.stage.dataset.expression = this.currentExpression;
    }
    if (this.faceBadge) {
      this.faceBadge.textContent = EXPRESSION_EMOJI[this.currentExpression] || '🙂';
      const safeWeight = Math.min(1, Math.max(0.2, Number(weight) || 0.5));
      this.faceBadge.style.opacity = String(safeWeight);
    }
  }

  // --- conversation-driven cues ---

  noteUserEngagement() {
    this.state = 'listening';
    this.#queueAutoGesture('listen');
  }

  beginThinking(mode = 'user') {
    this.state = mode === 'timer' ? 'reengaging' : 'thinking';
    this.setExpression('relaxed', 0.3, 0.16);
    this.#queueAutoGesture(mode === 'timer' ? 'wave' : 'think', { cooldownDivisor: 2 });
  }

  reactToAssistantReply({ mode = 'user', text = '', usedToolEffects = false } = {}) {
    this.state = mode === 'timer' ? 'auto-speaking' : 'speaking';
    if (mode === 'timer') {
      this.setExpression('happy', 0.5, 0.18);
    } else {
      this.setExpression('relaxed', 0.24, 0.18);
    }
    if (!usedToolEffects) {
      this.#queueAutoGesture(this.#pickFallbackMotion(mode, text));
    }
  }

  update() {
    if (this.currentMotion && Date.now() >= this.motionEndsAt) {
      this.motionEndsAt = Infinity;
      this.#goIdle();
    }
  }

  refreshClips() {
    this.clips = null;
  }

  // --- internals ---

  #buildDom() {
    if (!this.stage) {
      return;
    }
    this.stage.classList.add('sprite2d-stage');
    this.frame = document.createElement('img');
    this.frame.className = 'sprite2d-frame';
    this.frame.alt = 'companion sprite';
    this.frame.style.display = 'none';
    this.placeholder = document.createElement('div');
    this.placeholder.className = 'sprite2d-placeholder';
    this.placeholder.textContent = '⟨ idle ⟩';
    // No emoji face badge — expression is tracked in state / stage dataset only.
    this.faceBadge = null;
    this.stage.append(this.frame, this.placeholder);
  }

  async #loadClips() {
    if (this.clips && Object.keys(this.clips).length) {
      return this.clips;
    }
    try {
      const response = await fetch(this.animationsUrl);
      this.clips = response.ok ? this.#indexClips(await response.json()) : {};
    } catch {
      this.clips = {};
    }
    return this.clips;
  }

  #indexClips(data) {
    const list = Array.isArray(data)
      ? data
      : data?.records || data?.animations || data?.items || data?.clips || [];
    const map = {};
    for (const entry of list) {
      if (!entry) {
        continue;
      }
      const name = entry.name || entry.label || entry.clip || entry.id;
      const gif = entry.gif || entry.gifUrl || entry.gif_url || entry.url || entry.output || entry.path;
      if (name && gif) {
        map[String(name).toLowerCase()] = gif;
      }
    }
    return map;
  }

  #resolveClipName(name, clips) {
    if (!name) {
      return null;
    }
    const lower = String(name).toLowerCase();
    if (clips[lower]) {
      return lower;
    }
    const alias = MOTION_ALIASES[lower];
    if (alias && clips[alias]) {
      return alias;
    }
    return null;
  }

  #showGif(url) {
    if (!this.frame) {
      return;
    }
    this.placeholder.style.display = 'none';
    this.frame.style.display = '';
    // Reassigning src restarts the GIF from its first frame (served from cache).
    if (this.frame.getAttribute('src') === url) {
      this.frame.removeAttribute('src');
      void this.frame.offsetWidth; // force reflow so the reassignment takes effect
    }
    this.frame.src = url;
  }

  #showPlaceholder(label) {
    if (!this.frame) {
      return;
    }
    this.frame.style.display = 'none';
    this.placeholder.style.display = '';
    this.placeholder.textContent = label ? `⟨ ${label} ⟩` : '⟨ idle ⟩';
  }

  #goIdle() {
    this.currentMotion = null;
    this.motionEndsAt = Infinity;
    const idle = this.config?.motion?.defaultIdle || 'idle';
    if (idle && idle !== 'none') {
      this.playMotion(idle, { loop: true });
    } else {
      this.#showPlaceholder('idle');
    }
  }

  #pickFallbackMotion(mode, text) {
    if (mode === 'timer') {
      return Math.random() > 0.4 ? 'wave' : 'nod';
    }
    if (text.includes('？') || text.includes('?')) {
      return 'listen';
    }
    if (text.includes('喜欢') || text.includes('爱') || text.includes('谢谢')) {
      return 'happy';
    }
    if (text.includes('困') || text.includes('睡') || text.includes('晚安')) {
      return 'sleepy';
    }
    if (text.length > 48) {
      return 'think';
    }
    return 'nod';
  }

  #queueAutoGesture(name, options = {}) {
    if (!this.config?.motion?.enableAutoGesture || !name) {
      return;
    }
    const cooldown = (this.config.motion.autoGestureCooldownMs || 2800) / (options.cooldownDivisor || 1);
    if (Date.now() - this.lastAutoGestureAt < cooldown) {
      return;
    }
    this.lastAutoGestureAt = Date.now();
    this.playMotion(name, { intensity: 0.72 });
  }
}

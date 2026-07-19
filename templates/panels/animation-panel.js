// Sprite-sheet action animation panel (Track B).
//
// export mount() -> mounts the UI into #animation-panel. Talks to:
//   POST /api/animate      { idea|description, rows, cols, style, era,
//                            lighting, composition, color, mode, name, fps }
//   GET  /api/animations   -> { records: [...] }
// Generated assets are served from /animations/<file>.
//
// Form state + the active project's history references persist in
// localStorage under the key `studio_anim_v1`.

const LS_KEY = 'studio_anim_v1';

// The image-edit endpoint accepts at most EDIT_MAX_IMAGES images per request.
// The blank grid template always occupies one slot, so the remaining slots are
// available for character references (global full-body ref + individual parts),
// which all share ONE "图片 1..N" sequence.
const EDIT_MAX_IMAGES = 16;
const GRID_TEMPLATE_SLOTS = 1;
const MAX_REF_PARTS = EDIT_MAX_IMAGES - GRID_TEMPLATE_SLOTS; // 15

// Ordered list of selected part ids (selection order == "图片1..N" numbering).
let selectedParts = [];

// Style / cinematography enums (mirrors the reference notebook).
const STYLES = ['Pixel Art', 'Watercolor', 'Oil Painting', 'Sketch', 'Anime',
  'Flat Design', '3D Render', 'Vector Art', 'Impressionism', 'Cyberpunk'];
const ERAS = ['None', 'Ancient', 'Medieval', 'Renaissance', 'Victorian',
  '1920s', '1950s', '1980s', 'Modern', 'Futuristic'];
const LIGHTINGS = ['None', 'Natural Light', 'Studio Lighting', 'Cinematic Lighting',
  'Volumetric Lighting', 'Neon Lights', 'Bioluminescence', 'Low Key', 'High Key'];
const COMPOSITIONS = ['None', 'Close-up', 'Medium Shot', 'Wide Shot', "Bird's Eye View",
  "Worm's Eye View", 'Isometric', 'Rule of Thirds', 'Symmetrical'];
const COLORS = ['None', 'Monochromatic', 'Analogous', 'Complementary', 'Triadic',
  'Pastel', 'Vibrant', 'Muted', 'Black and White', 'Sepia'];
const DIMS = [2, 3, 4, 5, 6];

// GIF playback speed (frames per second). Baked into the GIF at encode time;
// the browser <img> plays whatever delay the file was encoded with.
const FPS_OPTIONS = [2, 3, 5, 8, 10, 12, 15, 20, 24];
const DEFAULT_FPS = 5;

// Action names the RPG sprite can play (Sprite2DController indexes clips by name).
// These map 1:1 to the sprite's canonical clips + friendly aliases.
const ACTIONS = ['idle', 'wave', 'nod', 'think', 'happy', 'listen', 'sleepy'];

// The full-body reference is a normal entry in the shared ref sequence, but it
// lives in the pipeline config rather than /api/parts, so it's tracked by id.
const GLOBAL_REF_ID = 'global_reference';

const PANEL_CSS = `
#animation-panel .anim-wrap { display: flex; flex-direction: column; gap: 12px; padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
#animation-panel .anim-title { font-size: 14px; font-weight: 600; }
#animation-panel .anim-sub { font-size: 11px; color: #888; font-weight: 400; }
#animation-panel .anim-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
#animation-panel .anim-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: #555; }
#animation-panel .anim-field select, #animation-panel .anim-field input,
#animation-panel .anim-idea textarea { padding: 5px 8px; font-size: 12px; border: 1px solid #e0e0e0;
  border-radius: 4px; background: #fff; }
#animation-panel .anim-idea { flex: 1; min-width: 220px; }
#animation-panel .anim-idea textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 46px; }
#animation-panel button { padding: 6px 14px; font-size: 12px; border: 1px solid #e0e0e0;
  border-radius: 4px; background: #fff; cursor: pointer; }
#animation-panel button.primary { background: var(--accent, #4a90d9); color: #fff;
  border-color: var(--accent, #4a90d9); }
#animation-panel button.primary:disabled { opacity: .55; cursor: default; }
#animation-panel .anim-status { font-size: 12px; color: #666; min-height: 16px; }
#animation-panel .anim-status.err { color: #d9534f; }
#animation-panel .anim-previews { display: flex; gap: 16px; flex-wrap: wrap; }
#animation-panel .anim-preview { border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px;
  background: #fafafa; }
#animation-panel .anim-preview h4 { margin: 0 0 6px; font-size: 11px; color: #777; }
#animation-panel .anim-preview img { max-width: 320px; max-height: 320px; display: block;
  border: 1px solid #eee; border-radius: 4px; background: #fff; }
#animation-panel .anim-history { display: flex; flex-direction: column; gap: 4px; }
#animation-panel .anim-history .item { display: flex; gap: 10px; align-items: center; padding: 6px 8px;
  border: 1px solid #eee; border-radius: 4px; cursor: pointer; font-size: 12px; background: #fff; }
#animation-panel .anim-history .item:hover { background: #f0f4ff; }
#animation-panel .anim-history .item img { width: 40px; height: 40px; object-fit: cover;
  border: 1px solid #eee; border-radius: 3px; }
#animation-panel .anim-history .item .desc { flex: 1; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
#animation-panel .anim-history .item .badge { font-size: 10px; color: #999; }
#animation-panel .anim-parts { display: flex; flex-direction: column; gap: 5px; }
#animation-panel .anim-parts .hint { font-size: 11px; color: #888; }
#animation-panel .anim-parts .chips { display: flex; gap: 6px; flex-wrap: wrap; }
#animation-panel .anim-parts .chip { display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 9px; font-size: 12px; border: 1px solid #e0e0e0; border-radius: 14px;
  background: #fff; cursor: pointer; user-select: none; }
#animation-panel .anim-parts .chip:hover { background: #f0f4ff; }
#animation-panel .anim-parts .chip.sel { background: var(--accent, #4a90d9); color: #fff;
  border-color: var(--accent, #4a90d9); }
#animation-panel .anim-parts .chip .ord { font-size: 10px; font-weight: 700; min-width: 14px;
  height: 14px; line-height: 14px; text-align: center; border-radius: 50%;
  background: rgba(255,255,255,.85); color: var(--accent, #4a90d9); }
#animation-panel .anim-parts .chip.disabled { opacity: .4; cursor: default; }
#animation-panel .anim-globalref { display: flex; align-items: center; gap: 6px; font-size: 12px; }
#animation-panel .anim-globalref .chip.unavail { opacity: .4; cursor: default; }
#animation-panel .anim-history .item .act { font-size: 11px; padding: 1px 4px;
  border: 1px solid #ddd; border-radius: 4px; background: #fff; }
`;

/** Create a labelled <select>. */
function selectField(label, name, options, value) {
  const field = document.createElement('label');
  field.className = 'anim-field';
  field.textContent = label;
  const sel = document.createElement('select');
  sel.name = name;
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = String(opt);
    o.textContent = String(opt);
    if (String(opt) === String(value)) o.selected = true;
    sel.appendChild(o);
  }
  field.appendChild(sel);
  return field;
}

/** Load persisted form state (best effort). */
function loadState() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || {};
  } catch {
    return {};
  }
}

/** Persist form state (best effort). */
function saveState(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage full or unavailable — non-fatal */
  }
}

/** Read the current form values into a plain object. */
function readForm(root) {
  const get = (n) => root.querySelector(`[name="${n}"]`)?.value ?? '';
  return {
    idea: get('idea'),
    rows: Number(get('rows')),
    cols: Number(get('cols')),
    style: get('style'),
    era: get('era'),
    lighting: get('lighting'),
    composition: get('composition'),
    color: get('color'),
    mode: get('mode'),
    name: get('name'), // action name for RPG sprite playback
    fps: Number(get('fps')) || DEFAULT_FPS, // GIF playback speed (frames/sec)
    // Global reference + parts share one ordered sequence (global ref pinned first).
    ref_parts: [...selectedParts],
  };
}

/** Render the sheet + gif previews for a record. */
function renderPreviews(root, record) {
  const box = root.querySelector('.anim-previews');
  box.innerHTML = '';
  const add = (title, url) => {
    if (!url) return;
    const wrap = document.createElement('div');
    wrap.className = 'anim-preview';
    const h = document.createElement('h4');
    h.textContent = title;
    const img = document.createElement('img');
    img.src = url;
    img.alt = title;
    wrap.append(h, img);
    box.appendChild(wrap);
  };
  add('Sprite Sheet 精灵表', record.sheet_url);
  add('Preview 预览', record.gif_url);
}

/** Fetch history and render the list. */
async function refreshHistory(root) {
  let records = [];
  try {
    const res = await fetch('/api/animations');
    if (res.ok) records = (await res.json()).records || [];
  } catch {
    return; // offline — leave the list as-is
  }
  const list = root.querySelector('.anim-history');
  list.innerHTML = '';
  for (const rec of records.slice().reverse()) {
    const item = document.createElement('div');
    item.className = 'item';
    const thumb = document.createElement('img');
    thumb.src = rec.gif_url || rec.sheet_url || '';
    thumb.alt = '';
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = rec.description || rec.idea || '(no description)';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const g = rec.grid_config || {};
    badge.textContent = `${g.rows ?? '?'}×${g.cols ?? '?'} · ${rec.generation_mode || 'new'}`;

    // Per-record action select — reassigns the sprite clip name via PATCH.
    const act = document.createElement('select');
    act.className = 'act';
    act.title = '动作 Action';
    for (const a of ['(none)', ...ACTIONS]) {
      const o = document.createElement('option');
      o.value = a === '(none)' ? '' : a;
      o.textContent = a;
      if (o.value === (rec.name || '')) o.selected = true;
      act.appendChild(o);
    }
    // Stop the row's click (preview) from firing when using the select.
    act.addEventListener('click', (e) => e.stopPropagation());
    act.addEventListener('change', async (e) => {
      e.stopPropagation();
      try {
        await fetch(`/api/animations/${rec.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: act.value }),
        });
        rec.name = act.value; // keep local copy in sync
      } catch {
        /* offline — leave the select as the user set it */
      }
    });

    item.append(thumb, desc, act, badge);
    item.addEventListener('click', () => renderPreviews(root, rec));
    list.appendChild(item);
  }
}

/** POST the form to /api/animate. */
async function generate(root) {
  const btn = root.querySelector('.anim-generate');
  const status = root.querySelector('.anim-status');
  const form = readForm(root);
  saveState(form);

  if (!form.idea.trim()) {
    status.textContent = 'Enter an idea first. 请先输入创意。';
    status.classList.add('err');
    return;
  }
  status.classList.remove('err');
  status.textContent = 'Generating… 生成中(流式，可能需要 5–15 分钟)';
  btn.disabled = true;

  try {
    const res = await fetch('/api/animate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    status.textContent = 'Done. 完成。';
    renderPreviews(root, data.record || data);
    await refreshHistory(root);
    // Notify other panels (RPG sprite) that the animation library changed so
    // they can invalidate their cached clip index — otherwise the new clip is
    // only playable after a full page reload.
    window.dispatchEvent(new CustomEvent('animations:updated', {
      detail: { record: data.record || data },
    }));
  } catch (err) {
    status.classList.add('err');
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/**
 * Load the global reference + generated parts and wire them into ONE shared
 * "图片 1..N" sequence (`selectedParts`).
 *
 * The global full-body reference and the individual parts share a single
 * ordinal numbering so a prompt like "图片1" is unambiguous. When selected, the
 * global reference is pinned to the front of the sequence (图片1); parts follow
 * in click order. Everything counts against MAX_REF_PARTS together.
 */
async function loadRefs(root, savedRefs) {
  const globalBox = root.querySelector('.anim-globalref');
  const chips = root.querySelector('.anim-parts .chips');
  if (!chips) return;

  // Discover which references are actually available (have a generated PNG).
  let globalAvailable = false;
  try {
    globalAvailable = (await fetch(`/parts/${GLOBAL_REF_ID}.png`, { method: 'HEAD' })).ok;
  } catch {
    globalAvailable = false;
  }

  let parts = [];
  try {
    const res = await fetch('/api/parts');
    if (res.ok) parts = await res.json();
  } catch {
    chips.textContent = '(无法加载部件列表)';
    return;
  }
  const available = parts.filter((p) => p && p.generated);
  const availIds = new Set(available.map((p) => p.id));
  if (globalAvailable) availIds.add(GLOBAL_REF_ID);

  // Restore saved selection (still-available ids only), preserving the exact
  // saved order so ordinals never shift under the user (a prompt that says
  // "图片3" must keep pointing at the same reference across reloads).
  selectedParts = (savedRefs || []).filter((id) => availIds.has(id));

  const orderOf = (id) => selectedParts.indexOf(id); // shared 0-based ordinal

  // Toggle helper. Ordinals follow CLICK ORDER, not group/render order: a newly
  // selected ref is always appended to the end, so previously selected refs keep
  // their numbers. Deselecting removes it; refs selected after it shift down by
  // one (unavoidable — the sequence sent to the model must stay contiguous 1..N).
  const toggle = (id) => {
    const i = selectedParts.indexOf(id);
    if (i >= 0) {
      selectedParts.splice(i, 1); // deselect
    } else if (selectedParts.length < MAX_REF_PARTS) {
      selectedParts.push(id); // select — append in click order (incl. global ref)
    } else {
      return; // at cap — ignore
    }
    render();
  };

  const render = () => {
    const atCap = selectedParts.length >= MAX_REF_PARTS;

    // Global reference chip (shares the ordinal sequence).
    if (globalBox) {
      globalBox.innerHTML = '';
      const chip = document.createElement('span');
      if (!globalAvailable) {
        chip.className = 'chip unavail';
        chip.textContent = '全身参考 (未生成)';
      } else {
        const ord = orderOf(GLOBAL_REF_ID);
        const sel = ord >= 0;
        chip.className = 'chip' + (sel ? ' sel' : atCap ? ' disabled' : '');
        chip.innerHTML = (sel ? `<span class="ord">${ord + 1}</span>` : '') +
          '<span>全身参考 global reference</span>';
        chip.addEventListener('click', () => toggle(GLOBAL_REF_ID));
      }
      globalBox.appendChild(chip);
    }

    // Individual part chips.
    chips.innerHTML = '';
    if (available.length === 0) {
      chips.innerHTML = '<span class="anim-sub">还没有已生成的部件，请先在 Create 面板生成。</span>';
      return;
    }
    for (const p of available) {
      const ord = orderOf(p.id);
      const sel = ord >= 0;
      const chip = document.createElement('span');
      chip.className = 'chip' + (sel ? ' sel' : atCap ? ' disabled' : '');
      chip.innerHTML = (sel ? `<span class="ord">${ord + 1}</span>` : '') +
        `<span>${p.label_cn || p.id}</span>`;
      chip.addEventListener('click', () => toggle(p.id));
      chips.appendChild(chip);
    }
  };
  render();
}

/** Mount the animation panel. Safe to call once; no-op if already mounted. */
export function mount() {
  const container = document.getElementById('animation-panel');
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  container.appendChild(style);

  const saved = loadState();
  const wrap = document.createElement('div');
  wrap.className = 'anim-wrap';
  wrap.innerHTML = `
    <div class="anim-title">🎞️ Sprite Animation <span class="anim-sub">动作动画 · idea → sprite sheet → GIF</span></div>
    <div class="anim-row">
      <div class="anim-idea">
        <label class="anim-field">Idea 创意
          <textarea name="idea" placeholder="e.g. a fire wizard casting a spell / 挥手打招呼"></textarea>
        </label>
      </div>
    </div>
    <div class="anim-row anim-selects"></div>
    <div class="anim-parts">
      <div class="hint">全身参考 Global Reference <span class="anim-sub">与部件共用同一序列，按点选先后编号</span></div>
      <div class="anim-globalref"></div>
      <div class="hint">参考部件 Reference parts <span class="anim-sub">按点选先后编号「图片1…N」，含全身参考共 15 张</span></div>
      <div class="chips"></div>
    </div>
    <div class="anim-row">
      <button class="primary anim-generate">Generate 生成</button>
      <span class="anim-status"></span>
    </div>
    <div class="anim-previews"></div>
    <div class="anim-title" style="font-size:12px;">History 历史</div>
    <div class="anim-history"></div>
  `;
  container.appendChild(wrap);

  if (saved.idea) wrap.querySelector('[name="idea"]').value = saved.idea;

  const selects = wrap.querySelector('.anim-selects');
  selects.append(
    selectField('Rows 行', 'rows', DIMS, saved.rows ?? 3),
    selectField('Cols 列', 'cols', DIMS, saved.cols ?? 4),
    selectField('Style 风格', 'style', STYLES, saved.style ?? STYLES[0]),
    selectField('Era 时代', 'era', ERAS, saved.era ?? 'None'),
    selectField('Lighting 光照', 'lighting', LIGHTINGS, saved.lighting ?? 'None'),
    selectField('Composition 构图', 'composition', COMPOSITIONS, saved.composition ?? 'None'),
    selectField('Color 配色', 'color', COLORS, saved.color ?? 'None'),
    selectField('Mode 模式', 'mode', ['new', 'continue'], saved.mode ?? 'new'),
    selectField('Action 动作', 'name', ACTIONS, saved.name ?? ACTIONS[0]),
    selectField('Speed 速度(fps)', 'fps', FPS_OPTIONS, saved.fps ?? DEFAULT_FPS),
  );

  wrap.querySelector('.anim-generate').addEventListener('click', () => generate(wrap));
  // Global reference + parts share one sequence; loadRefs restores both from
  // the saved ref_parts (global ref is stored inline, pinned to the front).
  loadRefs(wrap, saved.ref_parts);
  refreshHistory(wrap);
}

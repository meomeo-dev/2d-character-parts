// Sprite-sheet action animation panel (Track B).
//
// export mount() -> mounts the UI into #animation-panel. Talks to:
//   POST /api/animate      { idea|description, rows, cols, style, era,
//                            lighting, composition, color, mode }
//   GET  /api/animations   -> { records: [...] }
// Generated assets are served from /animations/<file>.
//
// Form state + the active project's history references persist in
// localStorage under the key `studio_anim_v1`.

const LS_KEY = 'studio_anim_v1';

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
    item.append(thumb, desc, badge);
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
  status.textContent = 'Generating… 生成中(可能需要 30–60s)';
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
  } catch (err) {
    status.classList.add('err');
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
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
  );

  wrap.querySelector('.anim-generate').addEventListener('click', () => generate(wrap));
  refreshHistory(wrap);
}

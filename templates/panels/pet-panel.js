// Codex Pet Studio panel (pet atlas track).
//
// export mount() -> mounts the UI into #pet-panel. Drives the Codex desktop-pet
// atlas pipeline end to end:
//   POST /api/pet/prepare       { petName?, description?, styleNotes?, refParts? }
//                               -> { runId, petId, rows[], record }
//   POST /api/pet/generate-base { runId, refImages? } -> { base_url, record }
//   POST /api/pet/generate-row  { runId, state, mirrorFrom? }
//                               -> { state, derivedFrom, inspection, frame_urls[], strip_url }
//   POST /api/pet/compose       { runId } -> { validation, atlas_url, webp_url, record }
//   POST /api/pet/qa            { runId } -> { validation, contact_sheet_url, record }
//   POST /api/pet/package       { runId, outDir? } -> { manifest_path, spritesheet_path, record }
//   GET  /api/pet/runs          -> { records: [...] }
//   GET  /api/pet/runs/:id      -> { record }
//   GET  /api/parts             -> [...] (reference parts, reused for ref selection)
//
// Form state (petName / description / styleNotes / refParts) persists in
// localStorage under `studio_pet_v1`.

const LS_KEY = 'studio_pet_v1';

// At most this many reference parts can feed the pipeline (prepare.refParts).
const MAX_REF_PARTS = 8;

// The 9 Codex pet states, in canonical order, with their frame counts.
// `running` is the "working / processing" state (not locomotion); `idle` is the
// low-distraction resting loop. Order is fixed and must match the backend plan.
const PET_STATES = [
  { state: 'idle', frames: 6 },
  { state: 'running-right', frames: 8 },
  { state: 'running-left', frames: 8 },
  { state: 'waving', frames: 4 },
  { state: 'jumping', frames: 5 },
  { state: 'failed', frames: 8 },
  { state: 'waiting', frames: 6 },
  { state: 'running', frames: 6 },
  { state: 'review', frames: 6 },
];
const FRAMES_BY_STATE = Object.fromEntries(PET_STATES.map((s) => [s.state, s.frames]));

// Ordered list of selected reference part ids (selection order == label numbering).
let selectedParts = [];

// Active run context, populated by prepare()/loadRun(). Null until a run exists.
let currentRun = null; // { runId, petId, rows: [...] }

const PANEL_CSS = `
#pet-panel .pet-wrap { display: flex; flex-direction: column; gap: 12px; padding: 16px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
#pet-panel .pet-title { font-size: 14px; font-weight: 600; }
#pet-panel .pet-sub { font-size: 11px; color: #888; font-weight: 400; }
#pet-panel .pet-intro { font-size: 12px; color: #666; line-height: 1.5; }
#pet-panel .pet-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
#pet-panel .pet-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: #555; }
#pet-panel .pet-field input, #pet-panel .pet-field textarea { padding: 5px 8px; font-size: 12px;
  border: 1px solid #e0e0e0; border-radius: 4px; background: #fff; }
#pet-panel .pet-field.grow { flex: 1; min-width: 220px; }
#pet-panel .pet-field textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 46px; }
#pet-panel button { padding: 6px 14px; font-size: 12px; border: 1px solid #e0e0e0;
  border-radius: 4px; background: #fff; cursor: pointer; }
#pet-panel button.primary { background: var(--accent, #4a90d9); color: #fff;
  border-color: var(--accent, #4a90d9); }
#pet-panel button:disabled { opacity: .55; cursor: default; }
#pet-panel button.sm { padding: 3px 9px; font-size: 11px; }
#pet-panel .pet-status { font-size: 12px; color: #666; min-height: 16px; }
#pet-panel .pet-status.err { color: #d9534f; }
#pet-panel .pet-section { border: 1px solid #eee; border-radius: 6px; padding: 10px; background: #fafafa;
  display: flex; flex-direction: column; gap: 8px; }
#pet-panel .pet-section h3 { font-size: 12px; font-weight: 600; color: #555; margin: 0; }
#pet-panel .pet-parts { display: flex; flex-direction: column; gap: 5px; }
#pet-panel .pet-parts .hint { font-size: 11px; color: #888; }
#pet-panel .pet-parts .chips { display: flex; gap: 6px; flex-wrap: wrap; }
#pet-panel .pet-parts .chip { display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 9px; font-size: 12px; border: 1px solid #e0e0e0; border-radius: 14px;
  background: #fff; cursor: pointer; user-select: none; }
#pet-panel .pet-parts .chip:hover { background: #f0f4ff; }
#pet-panel .pet-parts .chip.sel { background: var(--accent, #4a90d9); color: #fff;
  border-color: var(--accent, #4a90d9); }
#pet-panel .pet-parts .chip.disabled { opacity: .4; cursor: default; }
#pet-panel .pet-parts .chip .ord { font-size: 10px; font-weight: 700; min-width: 14px;
  height: 14px; line-height: 14px; text-align: center; border-radius: 50%;
  background: rgba(255,255,255,.85); color: var(--accent, #4a90d9); }
#pet-panel .pet-plan { display: flex; flex-direction: column; gap: 4px; }
#pet-panel .pet-plan .prow { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px;
  border: 1px solid #eee; border-radius: 4px; background: #fff; font-size: 12px; }
#pet-panel .pet-plan .prow .name { font-weight: 600; min-width: 120px; }
#pet-panel .pet-plan .prow .frames { color: #999; min-width: 56px; }
#pet-panel .pet-plan .prow .grow { flex: 1; display: flex; flex-direction: column; gap: 4px; }
#pet-panel .pet-plan .prow .thumbs { display: flex; gap: 4px; flex-wrap: wrap; }
#pet-panel .pet-plan .prow .thumbs img { width: 40px; height: 40px; object-fit: contain;
  border: 1px solid #eee; border-radius: 3px; background: #fff; }
#pet-panel .pet-plan .prow .actions { display: flex; gap: 6px; align-items: center; }
#pet-panel .badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px;
  text-transform: uppercase; letter-spacing: .3px; }
#pet-panel .badge.pending { background: #f0f0f0; color: #888; }
#pet-panel .badge.generating { background: #fff4d6; color: #b8860b; }
#pet-panel .badge.ok { background: #e6f7e6; color: #2e7d32; }
#pet-panel .badge.warn { background: #fff3cd; color: #b8860b; }
#pet-panel .badge.error { background: #fdecea; color: #d9534f; }
#pet-panel .pet-report { font-size: 11px; display: flex; flex-direction: column; gap: 2px; }
#pet-panel .pet-report .r-ok { color: #2e7d32; }
#pet-panel .pet-report .r-warn { color: #b8860b; }
#pet-panel .pet-report .r-err { color: #d9534f; }
#pet-panel .pet-previews { display: flex; gap: 16px; flex-wrap: wrap; }
#pet-panel .pet-preview { border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px; background: #fff; }
#pet-panel .pet-preview h4 { margin: 0 0 6px; font-size: 11px; color: #777; }
#pet-panel .pet-preview img { max-width: 320px; max-height: 320px; display: block;
  border: 1px solid #eee; border-radius: 4px; background: #fff; }
#pet-panel .pet-hint { font-size: 11px; color: #666; }
#pet-panel .pet-hint code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; }
#pet-panel .pet-history { display: flex; flex-direction: column; gap: 4px; }
#pet-panel .pet-history .item { display: flex; gap: 10px; align-items: center; padding: 6px 8px;
  border: 1px solid #eee; border-radius: 4px; cursor: pointer; font-size: 12px; background: #fff; }
#pet-panel .pet-history .item:hover { background: #f0f4ff; }
#pet-panel .pet-history .item .desc { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#pet-panel .pet-history .item .badge { font-size: 10px; }
`;

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
    petName: get('petName').trim(),
    description: get('description').trim(),
    styleNotes: get('styleNotes').trim(),
    refParts: [...selectedParts],
  };
}

/**
 * POST JSON to an /api/pet/* endpoint and return the parsed body.
 * Throws Error(message) on network failure or non-2xx (reading {error}).
 * The special marker err.status carries the HTTP code so callers can branch
 * (e.g. treat 404 QA as "endpoint unavailable" instead of a hard failure).
 */
async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    throw new Error(`网络请求失败: ${netErr.message}`);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON body — leave data as {} */
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Set a status line, optionally as an error. */
function setStatus(el, msg, isErr) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}

/**
 * Map an inspection/validation result to a status badge class.
 * error > warn > ok. `pending`/`generating` are set explicitly by callers.
 */
function badgeClassFor(result) {
  if (!result) return 'pending';
  if (Array.isArray(result.errors) && result.errors.length) return 'error';
  if (result.ok === false) return 'error';
  if (Array.isArray(result.warnings) && result.warnings.length) return 'warn';
  return 'ok';
}

/** Update a badge element's class + label. */
function setBadge(el, cls, label) {
  if (!el) return;
  el.className = `badge ${cls}`;
  el.textContent = label || cls;
}

/**
 * Render an ok/errors/warnings report (from inspection or validation) into a
 * container using textContent only (interface text is untrusted -> no innerHTML).
 */
function renderReport(container, result) {
  if (!container) return;
  container.innerHTML = '';
  if (!result) return;
  if (result.ok === true) {
    const line = document.createElement('div');
    line.className = 'r-ok';
    line.textContent = '✓ 通过 OK';
    container.appendChild(line);
  }
  for (const e of result.errors || []) {
    const line = document.createElement('div');
    line.className = 'r-err';
    line.textContent = `✗ ${typeof e === 'string' ? e : JSON.stringify(e)}`;
    container.appendChild(line);
  }
  for (const w of result.warnings || []) {
    const line = document.createElement('div');
    line.className = 'r-warn';
    line.textContent = `⚠ ${typeof w === 'string' ? w : JSON.stringify(w)}`;
    container.appendChild(line);
  }
}

/**
 * Render the 9-row Visible Progress Plan from currentRun.rows. Each row shows
 * the state name, frame count, a status badge, a generate button (running-left
 * offers a "mirror running-right" option), frame thumbnails and an inspection
 * report. Rebuilt whenever the run changes; individual rows are refreshed
 * in-place by generateRow().
 */
function renderPlan(root) {
  const box = root.querySelector('.pet-plan');
  if (!box) return;
  box.innerHTML = '';
  if (!currentRun || !Array.isArray(currentRun.rows)) return;

  for (const row of currentRun.rows) {
    const state = row.state;
    const frames = row.usedCols ?? FRAMES_BY_STATE[state] ?? '?';

    const prow = document.createElement('div');
    prow.className = 'prow';
    prow.dataset.state = state;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = state;

    const fcount = document.createElement('span');
    fcount.className = 'frames';
    fcount.textContent = `${frames} 帧`;

    const badge = document.createElement('span');
    badge.className = 'badge';
    // Reflect any status the backend already reported for this row.
    setBadge(badge, statusToBadge(row.status), row.status || 'pending');

    const grow = document.createElement('div');
    grow.className = 'grow';
    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    const report = document.createElement('div');
    report.className = 'pet-report';
    grow.append(thumbs, report);

    const actions = document.createElement('div');
    actions.className = 'actions';

    // running-left is typically derived by mirroring running-right; offer both.
    let mirrorChk = null;
    if (state === 'running-left') {
      const lbl = document.createElement('label');
      lbl.className = 'pet-field';
      lbl.style.flexDirection = 'row';
      lbl.style.alignItems = 'center';
      lbl.style.gap = '4px';
      mirrorChk = document.createElement('input');
      mirrorChk.type = 'checkbox';
      mirrorChk.checked = true;
      lbl.append(mirrorChk, document.createTextNode('镜像 running-right'));
      actions.appendChild(lbl);
    }

    const genBtn = document.createElement('button');
    genBtn.className = 'sm';
    genBtn.textContent = '生成';
    genBtn.addEventListener('click', () => {
      const mirrorFrom = mirrorChk && mirrorChk.checked ? 'running-right' : undefined;
      generateRow(root, state, mirrorFrom, prow);
    });
    actions.appendChild(genBtn);

    prow.append(name, fcount, badge, grow, actions);
    box.appendChild(prow);
  }
}

/** Map a backend row.status string to a badge class. */
function statusToBadge(status) {
  switch (status) {
    case 'ok': return 'ok';
    case 'warn': return 'warn';
    case 'error': return 'error';
    case 'generating': return 'generating';
    default: return 'pending';
  }
}

/** Refresh a single plan row in-place with a generate-row response. */
function applyRowResult(prow, resp) {
  if (!prow) return;
  const badge = prow.querySelector('.badge');
  const thumbs = prow.querySelector('.thumbs');
  const report = prow.querySelector('.pet-report');
  const inspection = resp.inspection || null;

  const cls = badgeClassFor(inspection);
  setBadge(badge, cls, cls);

  if (thumbs) {
    thumbs.innerHTML = '';
    for (const url of resp.frame_urls || []) {
      if (!url) continue;
      const img = document.createElement('img');
      img.src = url;
      img.alt = `${resp.state || ''} frame`;
      thumbs.appendChild(img);
    }
  }
  renderReport(report, inspection);
}

/** ① Prepare — POST /api/pet/prepare, build the run + 9-row plan. */
async function prepare(root) {
  const btn = root.querySelector('.pet-prepare');
  const status = root.querySelector('.pet-prepare-status');
  const form = readForm(root);
  saveState(form);

  if (!form.description) {
    setStatus(status, '请先填写描述 description。', true);
    return;
  }
  setStatus(status, '准备中… Preparing plan…');
  btn.disabled = true;
  try {
    const data = await postJson('/api/pet/prepare', {
      petName: form.petName || undefined,
      description: form.description,
      styleNotes: form.styleNotes || undefined,
      refParts: form.refParts,
    });
    currentRun = {
      runId: data.runId,
      petId: data.petId,
      rows: Array.isArray(data.rows) ? data.rows : [],
      record: data.record,
    };
    setStatus(status, `已准备 runId=${data.runId} · ${currentRun.rows.length} 行计划`);
    renderPlan(root);
    updateRunGate(root);
  } catch (err) {
    setStatus(status, `准备失败: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** ② Generate base reference — POST /api/pet/generate-base. */
async function generateBase(root) {
  const btn = root.querySelector('.pet-base');
  const status = root.querySelector('.pet-base-status');
  if (!currentRun) {
    setStatus(status, '请先执行「① 准备」。', true);
    return;
  }
  setStatus(status, '生成基础参考图中… (可能耗时)');
  btn.disabled = true;
  try {
    const data = await postJson('/api/pet/generate-base', { runId: currentRun.runId });
    if (data.record) currentRun.record = data.record;
    setStatus(status, '基础参考图完成。');
    renderSinglePreview(root, '.pet-base-preview', '基础参考图 Base reference', data.base_url);
  } catch (err) {
    setStatus(status, `生成失败: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** Generate a single row — POST /api/pet/generate-row. Returns true on success. */
async function generateRow(root, state, mirrorFrom, prow) {
  if (!currentRun) return false;
  const badge = prow ? prow.querySelector('.badge') : null;
  setBadge(badge, 'generating', 'generating');
  const genBtn = prow ? prow.querySelector('button') : null;
  if (genBtn) genBtn.disabled = true;
  try {
    const body = { runId: currentRun.runId, state };
    if (mirrorFrom) body.mirrorFrom = mirrorFrom;
    const data = await postJson('/api/pet/generate-row', body);
    applyRowResult(prow, data);
    // Keep the in-memory row status in sync so re-renders reflect the result.
    const rowRef = currentRun.rows.find((r) => r.state === state);
    if (rowRef) rowRef.status = badgeClassFor(data.inspection);
    return true;
  } catch (err) {
    setBadge(badge, 'error', 'error');
    const report = prow ? prow.querySelector('.pet-report') : null;
    renderReport(report, { errors: [err.message] });
    return false;
  } finally {
    if (genBtn) genBtn.disabled = false;
  }
}

/** Generate all 9 rows serially (running-left mirrors running-right). */
async function generateAll(root) {
  const btn = root.querySelector('.pet-genall');
  const status = root.querySelector('.pet-genall-status');
  if (!currentRun) {
    setStatus(status, '请先执行「① 准备」。', true);
    return;
  }
  btn.disabled = true;
  const rows = root.querySelectorAll('.pet-plan .prow');
  let done = 0;
  for (const prow of rows) {
    const state = prow.dataset.state;
    setStatus(status, `生成中 ${done + 1}/${rows.length}: ${state}…`);
    const mirrorChk = prow.querySelector('input[type="checkbox"]');
    const mirrorFrom = mirrorChk && mirrorChk.checked ? 'running-right' : undefined;
    // eslint-disable-next-line no-await-in-loop
    await generateRow(root, state, mirrorFrom, prow);
    done += 1;
  }
  setStatus(status, `全部完成 ${done}/${rows.length}。`);
  btn.disabled = false;
}

/** ③ Compose atlas — POST /api/pet/compose. */
async function compose(root) {
  const btn = root.querySelector('.pet-compose');
  const status = root.querySelector('.pet-compose-status');
  if (!currentRun) {
    setStatus(status, '请先执行「① 准备」。', true);
    return;
  }
  setStatus(status, '合成 Atlas 中…');
  btn.disabled = true;
  try {
    const data = await postJson('/api/pet/compose', { runId: currentRun.runId });
    if (data.record) currentRun.record = data.record;
    setStatus(status, 'Atlas 合成完成。');
    renderSinglePreview(root, '.pet-compose-preview', 'Atlas 预览', data.atlas_url || data.webp_url);
    renderReport(root.querySelector('.pet-compose-report'), data.validation);
  } catch (err) {
    setStatus(status, `合成失败: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** ④ QA — POST /api/pet/qa. Gracefully handles a 404 (endpoint not ready). */
async function qa(root) {
  const btn = root.querySelector('.pet-qa');
  const status = root.querySelector('.pet-qa-status');
  if (!currentRun) {
    setStatus(status, '请先执行「① 准备」。', true);
    return;
  }
  setStatus(status, '质检中…');
  btn.disabled = true;
  try {
    const data = await postJson('/api/pet/qa', { runId: currentRun.runId });
    if (data.record) currentRun.record = data.record;
    setStatus(status, '质检完成。');
    renderSinglePreview(root, '.pet-qa-preview', 'Contact sheet', data.contact_sheet_url);
    renderReport(root.querySelector('.pet-qa-report'), data.validation);
  } catch (err) {
    if (err.status === 404) {
      setStatus(status, 'QA 端点暂不可用（稍后重试）。', true);
    } else {
      setStatus(status, `质检失败: ${err.message}`, true);
    }
  } finally {
    btn.disabled = false;
  }
}

/** ⑤ Package — POST /api/pet/package. Shows manifest + spritesheet paths. */
async function packagePet(root) {
  const btn = root.querySelector('.pet-package');
  const status = root.querySelector('.pet-package-status');
  if (!currentRun) {
    setStatus(status, '请先执行「① 准备」。', true);
    return;
  }
  setStatus(status, '打包中…');
  btn.disabled = true;
  try {
    const data = await postJson('/api/pet/package', { runId: currentRun.runId });
    if (data.record) currentRun.record = data.record;
    setStatus(status, '打包完成。');
    renderPackageResult(root, data);
  } catch (err) {
    setStatus(status, `打包失败: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** Render (or clear) a single labelled image preview into `selector`. */
function renderSinglePreview(root, selector, title, url) {
  const box = root.querySelector(selector);
  if (!box) return;
  box.innerHTML = '';
  if (!url) return;
  const wrap = document.createElement('div');
  wrap.className = 'pet-preview';
  const h = document.createElement('h4');
  h.textContent = title;
  const img = document.createElement('img');
  img.src = url;
  img.alt = title;
  wrap.append(h, img);
  box.appendChild(wrap);
}

/** Render the package result: manifest / spritesheet paths + a load hint. */
function renderPackageResult(root, data) {
  const box = root.querySelector('.pet-package-result');
  if (!box) return;
  box.innerHTML = '';

  const addPath = (label, value) => {
    if (!value) return;
    const line = document.createElement('div');
    line.className = 'pet-hint';
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    const code = document.createElement('code');
    code.textContent = value;
    line.append(strong, code);
    box.appendChild(line);
  };
  addPath('manifest', data.manifest_path);
  addPath('spritesheet', data.spritesheet_path);

  const petId = (currentRun && currentRun.petId) || '<id>';
  const hint = document.createElement('div');
  hint.className = 'pet-hint';
  const codeEl = document.createElement('code');
  codeEl.textContent = `~/.codex/pets/${petId}/`;
  hint.append(
    document.createTextNode('把该目录（含 pet.json + spritesheet.webp）放到 '),
    codeEl,
    document.createTextNode(' 即可在 Codex 中加载。'),
  );
  box.appendChild(hint);
}

/**
 * Enable/disable the downstream stage buttons based on whether a run exists.
 * Prepare is always available; the rest require currentRun.
 */
function updateRunGate(root) {
  const has = !!currentRun;
  for (const sel of ['.pet-base', '.pet-genall', '.pet-compose', '.pet-qa', '.pet-package']) {
    const btn = root.querySelector(sel);
    if (btn) btn.disabled = !has;
  }
}

/**
 * Load the generated character parts into the reference-selection chips, wiring
 * a shared ordered selection (`selectedParts`) capped at MAX_REF_PARTS. Mirrors
 * animation-panel's part chips (order == label numbering).
 */
async function loadRefs(root, savedRefs) {
  const chips = root.querySelector('.pet-parts .chips');
  if (!chips) return;

  let parts = [];
  try {
    const res = await fetch('/api/parts');
    if (res.ok) parts = await res.json();
  } catch {
    chips.textContent = '(无法加载部件列表)';
    return;
  }
  const available = (parts || []).filter((p) => p && p.generated);
  const availIds = new Set(available.map((p) => p.id));

  // Restore saved selection (still-available ids only), preserving saved order.
  selectedParts = (savedRefs || []).filter((id) => availIds.has(id));

  const orderOf = (id) => selectedParts.indexOf(id);

  const toggle = (id) => {
    const i = selectedParts.indexOf(id);
    if (i >= 0) {
      selectedParts.splice(i, 1);
    } else if (selectedParts.length < MAX_REF_PARTS) {
      selectedParts.push(id);
    } else {
      return; // at cap — ignore
    }
    saveState(readForm(root));
    render();
  };

  const render = () => {
    const atCap = selectedParts.length >= MAX_REF_PARTS;
    chips.innerHTML = '';
    if (available.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'pet-sub';
      hint.textContent = '还没有已生成的部件，可留空直接准备。';
      chips.appendChild(hint);
      return;
    }
    for (const p of available) {
      const ord = orderOf(p.id);
      const sel = ord >= 0;
      const chip = document.createElement('span');
      chip.className = 'chip' + (sel ? ' sel' : atCap ? ' disabled' : '');
      // textContent only (label is interface data) — build ordinal + label nodes.
      if (sel) {
        const ordEl = document.createElement('span');
        ordEl.className = 'ord';
        ordEl.textContent = String(ord + 1);
        chip.appendChild(ordEl);
      }
      const labelEl = document.createElement('span');
      labelEl.textContent = p.label_cn || p.id;
      chip.appendChild(labelEl);
      chip.addEventListener('click', () => toggle(p.id));
      chips.appendChild(chip);
    }
  };
  render();
}

/** Fetch run history (GET /api/pet/runs) and render the clickable list. */
async function refreshHistory(root) {
  let records = [];
  try {
    const res = await fetch('/api/pet/runs');
    if (res.ok) records = (await res.json()).records || [];
  } catch {
    return; // offline — leave the list as-is
  }
  const list = root.querySelector('.pet-history');
  if (!list) return;
  list.innerHTML = '';
  if (records.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'pet-sub';
    hint.textContent = '暂无历史记录。';
    list.appendChild(hint);
    return;
  }
  for (const rec of records.slice().reverse()) {
    const item = document.createElement('div');
    item.className = 'item';
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = rec.petName || rec.description || rec.petId || rec.runId || '(no description)';
    const badge = document.createElement('span');
    badge.className = 'badge pending';
    badge.textContent = rec.status || rec.stage || 'run';
    item.append(desc, badge);
    const runId = rec.runId || rec.id;
    item.addEventListener('click', () => loadRun(root, runId));
    list.appendChild(item);
  }
}

/** Load a past run (GET /api/pet/runs/:id) and rebuild the plan view. */
async function loadRun(root, runId) {
  const status = root.querySelector('.pet-history-status');
  if (!runId) return;
  setStatus(status, `加载 ${runId}…`);
  try {
    const res = await fetch(`/api/pet/runs/${encodeURIComponent(runId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const rec = data.record || data;
    currentRun = {
      runId: rec.runId || runId,
      petId: rec.petId,
      rows: Array.isArray(rec.rows) ? rec.rows : [],
      record: rec,
    };
    renderPlan(root);
    updateRunGate(root);
    // Restore any previews the record already carries.
    renderSinglePreview(root, '.pet-base-preview', '基础参考图 Base reference', rec.base_url);
    renderSinglePreview(root, '.pet-compose-preview', 'Atlas 预览', rec.atlas_url || rec.webp_url);
    setStatus(status, `已加载 ${currentRun.runId}`);
  } catch (err) {
    setStatus(status, `加载失败: ${err.message}`, true);
  }
}

/** Mount the pet panel. Safe to call once; no-op if already mounted. */
export function mount() {
  const container = document.getElementById('pet-panel');
  if (!container || container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  container.appendChild(style);

  const saved = loadState();
  const wrap = document.createElement('div');
  wrap.className = 'pet-wrap';
  // Static structural markup only (no user/interface data) — dynamic content is
  // populated with createElement/textContent below to avoid XSS.
  wrap.innerHTML = `
    <div class="pet-title">🐾 Codex Pet Studio <span class="pet-sub">桌宠生成 · 描述 → 9 状态 atlas → Codex 桌宠</span></div>
    <div class="pet-intro">这是「Codex 桌宠生成」：填写描述并选参考部件，按顺序 准备 → 基础图 → 逐行生成 9 个状态 → 合成 Atlas → 质检 → 打包，即可得到可在 Codex 中加载的桌宠。</div>

    <div class="pet-section">
      <h3>表单 Form</h3>
      <div class="pet-row">
        <label class="pet-field"><span>宠物名 Pet name（可空）</span>
          <input name="petName" placeholder="e.g. Pixel Cat" />
        </label>
      </div>
      <div class="pet-row">
        <label class="pet-field grow"><span>描述 Description</span>
          <textarea name="description" placeholder="描述这只桌宠的外观 / 性格 / 主题"></textarea>
        </label>
      </div>
      <div class="pet-row">
        <label class="pet-field grow"><span>风格备注 Style notes（可空）</span>
          <input name="styleNotes" placeholder="e.g. pixel art, warm palette" />
        </label>
      </div>
      <div class="pet-parts">
        <div class="hint">参考部件 Reference parts <span class="pet-sub">按点选先后编号，最多 ${MAX_REF_PARTS} 个</span></div>
        <div class="chips"></div>
      </div>
      <div class="pet-row">
        <button class="primary pet-prepare">① 准备 Prepare</button>
        <span class="pet-status pet-prepare-status"></span>
      </div>
    </div>

    <div class="pet-section">
      <h3>进度计划 Visible Progress Plan</h3>
      <div class="pet-plan"></div>
      <div class="pet-row">
        <button class="pet-genall" disabled>全部生成 Generate all</button>
        <span class="pet-status pet-genall-status"></span>
      </div>
    </div>

    <div class="pet-section">
      <h3>② 基础参考图 Base reference</h3>
      <div class="pet-row">
        <button class="pet-base" disabled>② 生成基础参考图</button>
        <span class="pet-status pet-base-status"></span>
      </div>
      <div class="pet-previews pet-base-preview"></div>
    </div>

    <div class="pet-section">
      <h3>③ 合成 Atlas Compose</h3>
      <div class="pet-row">
        <button class="pet-compose" disabled>③ 合成 Atlas</button>
        <span class="pet-status pet-compose-status"></span>
      </div>
      <div class="pet-report pet-compose-report"></div>
      <div class="pet-previews pet-compose-preview"></div>
    </div>

    <div class="pet-section">
      <h3>④ 质检 QA</h3>
      <div class="pet-row">
        <button class="pet-qa" disabled>④ 质检</button>
        <span class="pet-status pet-qa-status"></span>
      </div>
      <div class="pet-report pet-qa-report"></div>
      <div class="pet-previews pet-qa-preview"></div>
    </div>

    <div class="pet-section">
      <h3>⑤ 打包 Package</h3>
      <div class="pet-row">
        <button class="pet-package" disabled>⑤ 打包为 Codex 桌宠</button>
        <span class="pet-status pet-package-status"></span>
      </div>
      <div class="pet-package-result"></div>
    </div>

    <div class="pet-section">
      <h3>历史 History</h3>
      <span class="pet-status pet-history-status"></span>
      <div class="pet-history"></div>
    </div>
  `;
  container.appendChild(wrap);

  // Restore saved form values.
  if (saved.petName) wrap.querySelector('[name="petName"]').value = saved.petName;
  if (saved.description) wrap.querySelector('[name="description"]').value = saved.description;
  if (saved.styleNotes) wrap.querySelector('[name="styleNotes"]').value = saved.styleNotes;

  // Wire up buttons.
  wrap.querySelector('.pet-prepare').addEventListener('click', () => prepare(wrap));
  wrap.querySelector('.pet-base').addEventListener('click', () => generateBase(wrap));
  wrap.querySelector('.pet-genall').addEventListener('click', () => generateAll(wrap));
  wrap.querySelector('.pet-compose').addEventListener('click', () => compose(wrap));
  wrap.querySelector('.pet-qa').addEventListener('click', () => qa(wrap));
  wrap.querySelector('.pet-package').addEventListener('click', () => packagePet(wrap));

  // Persist form edits as the user types.
  for (const n of ['petName', 'description', 'styleNotes']) {
    const el = wrap.querySelector(`[name="${n}"]`);
    if (el) el.addEventListener('change', () => saveState(readForm(wrap)));
  }

  loadRefs(wrap, saved.refParts);
  refreshHistory(wrap);
}








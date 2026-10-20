// app.js — PDF Page Organizer: thumbnails with pdf.js, page edits in a simple model, a new PDF built by pdf-lib in worker.js.
// Everything runs on this device; the only fetch() is in window.__demo, which loads a bundled fixture.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const THUMB = 160; // thumbnail size in CSS pixels (longest side)
const MAX_UNDO = 300;

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const organizer = $('organizer');
const grid = $('page-grid');
const results = $('results');
const summary = $('summary');
const announcer = $('announce');
const btn = {
  selectAll: $('select-all'), rotateSel: $('rotate-selected'), deleteSel: $('delete-selected'),
  undo: $('undo'), save: $('save'), another: $('open-another'),
};

// ---------- state ----------
let doc = null;          // { name, outName, size, bytes: Uint8Array, pdf: PDFDocumentProxy, rotations: number[] }
let pages = [];          // the model: [{ id, src, rot, deleted }] in the new order
let history = [];        // undo stack of model snapshots
let selected = new Set();
let focusId = 0;         // roving tabindex
let busy = false;
let loadToken = 0;
const cards = new Map(); // id -> { el, canvas, src, visible, rendered, task, queued }

const norm = (deg) => ((deg % 360) + 360) % 360;
const snapshot = () => pages.map((p) => ({ ...p }));
const pageOf = (id) => pages.find((p) => p.id === id);
const indexOf = (id) => pages.findIndex((p) => p.id === id);

// ---------- pdf.js (loaded on first use) ----------
let pdfjsPromise = null;
function getPdfjs() {
  pdfjsPromise ||= import('./vendor/pdfjs-dist/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = './vendor/pdfjs-dist/pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

// ---------- pdf-lib worker ----------
let worker = null;
let seq = 0;
const jobs = new Map();
function runWorker(msg, onProgress) {
  if (!worker) {
    worker = new Worker('./worker.js');
    worker.onmessage = (e) => {
      const job = jobs.get(e.data.id);
      if (!job) return;
      if (e.data.type === 'progress') { job.onProgress?.(e.data.value, e.data.label); return; }
      jobs.delete(e.data.id);
      if (e.data.type === 'error') job.reject(Object.assign(new Error(e.data.error.message), e.data.error));
      else job.resolve(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      for (const job of jobs.values()) job.reject(new Error('The PDF engine stopped unexpectedly. The file may be too large for this device.'));
      jobs.clear();
      worker.terminate();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id }, msg.bytes ? [msg.bytes.buffer] : []);
  });
}

// ---------- messages ----------
function clearMessages() { results.replaceChildren(); }

function showError(message) {
  const el = document.createElement('div');
  el.className = 'alert alert--error';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  results.appendChild(el);
  el.scrollIntoView({ block: 'nearest' });
  return el;
}

function showProgress(label) {
  const wrap = document.createElement('div');
  wrap.className = 'save-progress';
  wrap.innerHTML = '<div class="save-progress__label"><span class="spinner" aria-hidden="true"></span><span class="save-progress__text"></span><span class="save-progress__pct stat"></span></div><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>';
  const text = wrap.querySelector('.save-progress__text');
  const pct = wrap.querySelector('.save-progress__pct');
  const bar = wrap.querySelector('.progress');
  text.textContent = label;
  results.appendChild(wrap);
  return {
    set(value, newLabel) {
      const p = Math.max(0, Math.min(100, Math.floor(value * 100))); // floor: 99.9% is not 100%
      bar.firstElementChild.style.width = `${p}%`;
      bar.setAttribute('aria-valuenow', String(p));
      pct.textContent = `${p}%`;
      if (newLabel) text.textContent = newLabel;
    },
    remove() { wrap.remove(); },
  };
}

function announce(message) {
  announcer.textContent = '';
  requestAnimationFrame(() => { announcer.textContent = message; });
}

// ---------- loading ----------
const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

function looksLikePdf(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF-');
}

function loadErrorMessage(err, name) {
  if (err && (err.name === 'PasswordException' || err.encrypted)) {
    return `“${name}” is password protected or encrypted, which is not supported. Remove the password in the app that created it, then open it here again.`;
  }
  return `“${name}” could not be read as a PDF. The file may be damaged or incomplete.`;
}

async function handleFiles(files) {
  if (busy) return;
  const list = [...files];
  const pdfs = list.filter(isPdfFile);
  const others = list.filter((f) => !isPdfFile(f));
  const notes = [];
  if (others.length) {
    const names = others.map((f) => `“${f.name}”`).join(', ');
    notes.push(`${names} ${others.length === 1 ? 'is not a PDF' : 'are not PDFs'}, so ${others.length === 1 ? 'it was' : 'they were'} skipped. Only .pdf files can be organized.`);
  }
  if (pdfs.length > 1) notes.push(`This tool organizes one PDF at a time, so only “${pdfs[0].name}” was opened.`);
  if (!pdfs.length) {
    clearMessages();
    showError(notes[0] || 'Choose a PDF file (.pdf).');
    return;
  }
  const ok = await openPdf(pdfs[0]);
  if (ok) notes.forEach(showError);
}

function closeDocument() {
  loadToken++;
  for (const c of cards.values()) { observer.unobserve(c.el); c.task?.cancel(); }
  cards.clear();
  queue.length = 0;
  grid.replaceChildren();
  if (doc?.pdf) doc.pdf.destroy();
  doc = null;
  pages = [];
  history = [];
  selected = new Set();
}

async function openPdf(file) {
  closeDocument();
  const token = loadToken;
  clearMessages();
  busy = true;
  const prog = showProgress(`Opening “${file.name}”`);
  prog.set(0);
  let loadingTask = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikePdf(bytes)) throw Object.assign(new Error('not a pdf'), { name: 'InvalidPDFException' });
    const pdfjs = await getPdfjs();
    loadingTask = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false });
    loadingTask.onProgress = ({ loaded, total }) => { if (total) prog.set(0.9 * loaded / total); };
    const [pdf, info] = await Promise.all([loadingTask.promise, runWorker({ type: 'inspect', bytes: bytes.slice() })]);
    if (token !== loadToken) { pdf.destroy(); return false; }
    prog.remove();
    if (!info.pageCount) throw new Error('no pages');
    doc = {
      name: file.name,
      outName: `${file.name.replace(/\.pdf$/i, '') || 'document'}_organized.pdf`,
      size: file.size,
      bytes,
      pdf,
      rotations: info.rotations,
      pageCount: Math.min(info.pageCount, pdf.numPages),
    };
    pages = Array.from({ length: doc.pageCount }, (_, i) => ({ id: i, src: i, rot: 0, deleted: false }));
    focusId = 0;
    buildCards();
    $('file-name').textContent = doc.name;
    $('file-info').textContent = `${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'} · ${formatBytes(doc.size)} · read on this device, not uploaded`;
    zone.hidden = true;
    organizer.hidden = false;
    render();
    grid.firstElementChild?.scrollIntoView({ block: 'nearest' });
    toast(`Opened ${doc.pageCount} pages — nothing was uploaded`);
    return true;
  } catch (err) {
    loadingTask?.destroy();
    if (token !== loadToken) return false;
    prog.remove();
    resetToEmpty(false);
    showError(loadErrorMessage(err, file.name));
    return false;
  } finally {
    if (token === loadToken) busy = false;
  }
}

function resetToEmpty(clear = true) {
  closeDocument();
  organizer.hidden = true;
  zone.hidden = false;
  if (clear) clearMessages();
}

// ---------- cards ----------
const ICONS = {
  rotL: '<path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5"/><path d="M4 3.5v5h5"/>',
  rotR: '<path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5"/><path d="M20 3.5v5h-5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  restore: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function buildCards() {
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const n = p.src + 1;
    const el = document.createElement('li');
    el.className = 'page-card';
    el.dataset.id = String(p.id);
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="page-card__top">
        <label class="page-card__select"><input type="checkbox" data-act="select"><span class="visually-hidden">Select page ${n}</span></label>
        <span class="page-card__num" title="Original page ${n}">${n}</span>
        <span class="page-card__grip" title="Drag to move">${icon('grip')}</span>
      </div>
      <div class="page-card__thumb"><canvas aria-hidden="true"></canvas><span class="page-card__badge page-card__rot"></span><span class="page-card__badge page-card__removed">Removed</span></div>
      <div class="page-card__actions">
        <button class="icon-btn" type="button" data-act="rotl" aria-label="Rotate page ${n} left" title="Rotate left">${icon('rotL')}</button>
        <button class="icon-btn" type="button" data-act="rotr" aria-label="Rotate page ${n} right" title="Rotate right">${icon('rotR')}</button>
        <button class="icon-btn icon-btn--danger" type="button" data-act="delete" aria-label="Delete page ${n}" title="Delete">${icon('trash')}</button>
        <button class="icon-btn icon-btn--restore" type="button" data-act="restore" aria-label="Restore page ${n}">${icon('restore')}<span>Restore</span></button>
      </div>
      <div class="page-card__actions">
        <button class="icon-btn" type="button" data-act="earlier" aria-label="Move page ${n} earlier" title="Move earlier">${icon('left')}</button>
        <button class="icon-btn" type="button" data-act="later" aria-label="Move page ${n} later" title="Move later">${icon('right')}</button>
      </div>`;
    const c = { el, canvas: el.querySelector('canvas'), src: p.src, visible: false, rendered: false, task: null, queued: false };
    cards.set(p.id, c);
    frag.appendChild(el);
    observer.observe(el);
  }
  grid.appendChild(frag);
}

function render() {
  const active = document.activeElement;
  const hadFocus = grid.contains(active);
  if (!pages.some((p) => p.id === focusId)) focusId = pages[0]?.id ?? 0;
  pages.forEach((p, i) => {
    const c = cards.get(p.id);
    const el = c.el;
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    const n = p.src + 1;
    const rot = norm(p.rot);
    el.classList.toggle('is-deleted', p.deleted);
    el.classList.toggle('is-selected', selected.has(p.id));
    el.tabIndex = p.id === focusId ? 0 : -1;
    el.setAttribute('aria-label', `Page ${n}, position ${i + 1} of ${pages.length}${rot ? `, rotated ${rot}°` : ''}${p.deleted ? ', marked for deletion' : ''}`);
    c.canvas.style.transform = rot ? `rotate(${rot}deg)` : '';
    const badge = el.querySelector('.page-card__rot');
    badge.textContent = rot ? `${rot}°` : '';
    badge.hidden = !rot;
    el.querySelector('[data-act="select"]').checked = selected.has(p.id);
    el.querySelector('[data-act="earlier"]').disabled = i === 0;
    el.querySelector('[data-act="later"]').disabled = i === pages.length - 1;
    for (const b of el.querySelectorAll('[data-act="rotl"], [data-act="rotr"], [data-act="delete"]')) b.hidden = p.deleted;
    el.querySelector('[data-act="restore"]').hidden = !p.deleted;
  });
  if (hadFocus && document.activeElement !== active && document.contains(active)) {
    const target = active.hidden || active.disabled ? active.closest('.page-card') : active;
    target?.focus({ preventScroll: true });
  }
  updateToolbar();
}

function updateToolbar() {
  const total = pages.length;
  const kept = pages.filter((p) => !p.deleted).length;
  const removed = total - kept;
  const rotated = pages.filter((p) => !p.deleted && norm(p.rot)).length;
  const reordered = pages.filter((p) => !p.deleted).some((p, i, arr) => i > 0 && p.src < arr[i - 1].src);
  const sel = selected.size;
  const parts = [`Keeping ${kept} of ${total} ${total === 1 ? 'page' : 'pages'}`, `${removed} removed`];
  if (rotated) parts.push(`${rotated} rotated`);
  if (reordered) parts.push('new order');
  if (sel) parts.push(`${sel} selected`);
  summary.textContent = parts.join(' · ');
  summary.classList.toggle('is-empty', kept === 0);
  const allSelected = total > 0 && sel === total;
  btn.selectAll.textContent = allSelected ? 'Clear selection' : 'Select all';
  btn.selectAll.setAttribute('aria-pressed', String(allSelected));
  btn.rotateSel.disabled = busy || !sel;
  btn.deleteSel.disabled = busy || !sel;
  btn.undo.disabled = busy || !history.length;
  btn.save.disabled = busy;
  btn.selectAll.disabled = busy;
}

// ---------- actions (each one is undoable) ----------
function commit(mutate, message) {
  if (busy || !doc) return;
  const before = snapshot();
  mutate();
  if (JSON.stringify(before) === JSON.stringify(pages)) return;
  history.push(before);
  if (history.length > MAX_UNDO) history.shift();
  clearMessages(); // any saved result is now out of date
  render();
  if (message) announce(message);
}

function rotate(ids, delta) {
  commit(() => { for (const id of ids) { const p = pageOf(id); if (p && !p.deleted) p.rot = norm(p.rot + delta); } },
    ids.length === 1 ? `Page ${pageOf(ids[0]).src + 1} rotated ${delta > 0 ? 'right' : 'left'}` : `${ids.length} pages rotated`);
}

function setDeleted(ids, deleted) {
  commit(() => { for (const id of ids) { const p = pageOf(id); if (p) p.deleted = deleted; } },
    ids.length === 1 ? `Page ${pageOf(ids[0]).src + 1} ${deleted ? 'marked for deletion' : 'restored'}` : `${ids.length} pages ${deleted ? 'marked for deletion' : 'restored'}`);
}

function moveTo(id, to) {
  const from = indexOf(id);
  to = Math.max(0, Math.min(pages.length - 1, to));
  if (from < 0 || from === to) return;
  commit(() => { const [p] = pages.splice(from, 1); pages.splice(to, 0, p); },
    `Page ${pageOf(id).src + 1} moved to position ${to + 1} of ${pages.length}`);
}

function undo() {
  if (busy || !history.length) return;
  pages = history.pop();
  clearMessages();
  render();
  announce('Last change undone');
}

// ---------- thumbnails: lazy, cancelled when off screen, memory freed ----------
const queue = [];
let running = 0;
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const c = cards.get(Number(entry.target.dataset.id));
    if (!c) continue;
    c.visible = entry.isIntersecting;
    if (c.visible) enqueue(c);
    else releaseThumb(c);
  }
}, { rootMargin: '300px 0px' });

function enqueue(c) {
  if (c.rendered || c.task || c.queued) return;
  c.queued = true;
  queue.push(c);
  pump();
}

function pump() {
  while (running < 3 && queue.length) {
    const c = queue.shift();
    c.queued = false;
    if (!c.visible || c.rendered || c.task) continue;
    running++;
    drawThumb(c).finally(() => { running--; pump(); });
  }
}

function releaseThumb(c) {
  if (c.task) c.task.cancel();
  if (c.rendered) {
    c.canvas.width = 0; // frees the bitmap memory of thumbnails far off screen
    c.canvas.height = 0;
    c.rendered = false;
    c.el.classList.remove('is-rendered');
  }
}

async function drawThumb(c) {
  const token = loadToken;
  try {
    const page = await doc.pdf.getPage(c.src + 1);
    if (token !== loadToken || !c.visible) return;
    const base = page.getViewport({ scale: 1 }); // includes the page's own /Rotate
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: (THUMB * dpr) / Math.max(base.width, base.height) });
    const canvas = c.canvas;
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    canvas.style.width = `${(88 * base.width) / Math.max(base.width, base.height)}%`;
    c.task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
    await c.task.promise;
    if (token !== loadToken) return;
    c.rendered = true;
    c.el.classList.add('is-rendered');
    page.cleanup();
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException' && token === loadToken) {
      c.el.classList.add('is-failed');
      console.warn('thumbnail failed', err);
    }
    if (!c.rendered) { c.canvas.width = 0; c.canvas.height = 0; }
  } finally {
    c.task = null;
  }
}

async function thumbsIdle(timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 60));
    const pending = [...cards.values()].some((c) => c.visible && !c.rendered && !c.el.classList.contains('is-failed'));
    if (!pending && !running && !queue.length) return;
  }
}

// ---------- saving ----------
async function save({ download = true } = {}) {
  if (busy || !doc) return false;
  clearMessages();
  const kept = pages.filter((p) => !p.deleted);
  if (!kept.length) {
    showError('Every page is marked for deletion, so there is nothing to save. Restore at least one page (or press Undo) and try again.');
    return false;
  }
  busy = true;
  updateToolbar();
  btn.save.textContent = 'Saving…';
  const prog = showProgress('Building the new PDF');
  prog.set(0);
  try {
    const res = await runWorker({ type: 'build', bytes: doc.bytes.slice(), pages: kept.map((p) => ({ src: p.src, rot: p.rot })) },
      (value, label) => prog.set(value, label));
    prog.remove();
    const blob = new Blob([res.data], { type: 'application/pdf' });
    showSaved(blob, res.pageCount, pages.length - kept.length, download);
    if (download) downloadBlob(blob, doc.outName);
    return true;
  } catch (err) {
    prog.remove();
    showError(err.encrypted ? loadErrorMessage(err, doc.name) : `The new PDF could not be built: ${err.message}`);
    return false;
  } finally {
    busy = false;
    btn.save.textContent = 'Save PDF';
    updateToolbar();
  }
}

function showSaved(blob, pageCount, removed, downloaded) {
  const row = document.createElement('div');
  row.className = 'result result--saved';
  row.innerHTML = `
    <svg class="result__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7.5"/></svg>
    <div class="result__meta"><div class="result__name"></div><div class="result__info"></div></div>
    <button class="btn btn--primary btn--small result__download" id="download" type="button"></button>`;
  row.querySelector('.result__name').textContent = doc.outName;
  row.querySelector('.result__info').textContent =
    `${downloaded ? 'Downloaded' : 'Ready'} · ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} kept, ${removed} removed · ${formatBytes(blob.size)}`;
  const dl = row.querySelector('#download');
  const name = doc.outName;
  dl.innerHTML = '<span class="result__download-text"></span>';
  dl.firstElementChild.textContent = `Download ${name}`;
  dl.setAttribute('aria-label', `Download ${name}`);
  dl.addEventListener('click', () => downloadBlob(blob, name));
  results.appendChild(row);
  row.scrollIntoView({ block: 'nearest' });
  announce(`Saved ${name} with ${pageCount} pages`);
}

// ---------- events ----------
wireDropzone(zone, input, handleFiles);

btn.another.addEventListener('click', () => {
  if (busy) return;
  resetToEmpty();
  zone.focus();
});
btn.selectAll.addEventListener('click', () => {
  selected = selected.size === pages.length ? new Set() : new Set(pages.map((p) => p.id));
  render();
});
btn.rotateSel.addEventListener('click', () => rotate([...selected], 90));
btn.deleteSel.addEventListener('click', () => setDeleted([...selected], true));
btn.undo.addEventListener('click', undo);
btn.save.addEventListener('click', () => save());

grid.addEventListener('click', (e) => {
  const control = e.target.closest('[data-act]');
  const el = e.target.closest('.page-card');
  if (!control || !el) return;
  const id = Number(el.dataset.id);
  focusId = id;
  switch (control.dataset.act) {
    case 'rotl': rotate([id], -90); break;
    case 'rotr': rotate([id], 90); break;
    case 'delete': setDeleted([id], true); break;
    case 'restore': setDeleted([id], false); break;
    case 'earlier': moveTo(id, indexOf(id) - 1); break;
    case 'later': moveTo(id, indexOf(id) + 1); break;
    case 'select':
      if (control.checked) selected.add(id); else selected.delete(id);
      render();
      break;
  }
});

grid.addEventListener('focusin', (e) => {
  const el = e.target.closest('.page-card');
  if (!el) return;
  const id = Number(el.dataset.id);
  if (id !== focusId) {
    cards.get(focusId)?.el && (cards.get(focusId).el.tabIndex = -1);
    focusId = id;
    el.tabIndex = 0;
  }
});

function columns() {
  return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
}

function focusCard(i) {
  const p = pages[Math.max(0, Math.min(pages.length - 1, i))];
  if (!p) return;
  focusId = p.id;
  render();
  cards.get(p.id).el.focus();
  cards.get(p.id).el.scrollIntoView({ block: 'nearest' });
}

grid.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!el.classList?.contains('page-card')) return;
  const id = Number(el.dataset.id);
  const i = indexOf(id);
  const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() };
  if (e.key in steps) {
    e.preventDefault();
    if (e.altKey) { moveTo(id, i + steps[e.key]); el.focus(); el.scrollIntoView({ block: 'nearest' }); }
    else focusCard(i + steps[e.key]);
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    if (e.altKey) { moveTo(id, e.key === 'Home' ? 0 : pages.length - 1); el.focus(); }
    else focusCard(e.key === 'Home' ? 0 : pages.length - 1);
  } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    rotate([id], e.shiftKey ? -90 : 90);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    setDeleted([id], !pageOf(id).deleted);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (organizer.hidden || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest?.('input[type="text"], textarea, [contenteditable]')) return;
  e.preventDefault();
  undo();
});

// Drag to reorder with pointer events. Mouse and pen drag the whole card; touch drags by the grip,
// so scrolling a long grid on a phone still works (the move buttons are always visible too).
let drag = null;
grid.addEventListener('pointerdown', (e) => {
  if (busy || e.button !== 0) return;
  const el = e.target.closest('.page-card');
  if (!el) return;
  const onGrip = Boolean(e.target.closest('.page-card__grip'));
  if (!onGrip && (e.pointerType === 'touch' || e.target.closest('button, input, label'))) return;
  drag = { el, id: Number(el.dataset.id), x: e.clientX, y: e.clientY, sy: window.scrollY, pid: e.pointerId, active: false, target: null, after: false };
  if (onGrip) e.preventDefault();
});

function setDropTarget(target, after) {
  if (drag.target && (drag.target !== target || drag.after !== after)) drag.target.classList.remove('drop-before', 'drop-after');
  drag.target = target;
  drag.after = after;
  if (target) target.classList.add(after ? 'drop-after' : 'drop-before');
}

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.active) {
    if (Math.hypot(dx, dy) < 6) return;
    drag.active = true;
    drag.el.classList.add('is-dragging');
    document.body.classList.add('is-dragging-page');
  }
  e.preventDefault();
  drag.el.style.transform = `translate(${dx}px, ${dy + window.scrollY - drag.sy}px)`;
  const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page-card');
  if (under && under !== drag.el && grid.contains(under)) {
    const box = under.getBoundingClientRect();
    setDropTarget(under, e.clientX > box.left + box.width / 2);
  } else if (!under) {
    setDropTarget(null, false);
  }
  if (e.clientY < 70) window.scrollBy(0, -16);
  else if (e.clientY > window.innerHeight - 50) window.scrollBy(0, 16);
}, { passive: false });

function endDrag(commitDrop) {
  if (!drag) return;
  const { el, id, active, target, after } = drag;
  if (target) target.classList.remove('drop-before', 'drop-after');
  el.classList.remove('is-dragging');
  el.style.transform = '';
  document.body.classList.remove('is-dragging-page');
  drag = null;
  if (!active || !commitDrop || !target) return;
  const from = indexOf(id);
  let to = indexOf(Number(target.dataset.id)) + (after ? 1 : 0);
  if (from < to) to -= 1;
  focusId = id;
  moveTo(id, to);
  el.focus({ preventScroll: true });
}
window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pid) endDrag(true); });
window.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pid) endDrag(false); });

// Keep the sticky toolbar under the sticky site header.
const header = document.querySelector('.site-header');
const setHeaderOffset = () => document.documentElement.style.setProperty('--header-h', `${header ? header.offsetHeight : 0}px`);
setHeaderOffset();
window.addEventListener('resize', setHeaderOffset);

// Called by the factory's screenshot script to show the tool in a realistic, fictional state.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/aurora-labs-launch-deck.pdf');
  const file = new File([await res.blob()], 'aurora-labs-launch-deck.pdf', { type: 'application/pdf' });
  await handleFiles([file]);
  if (!doc) return;
  rotate([3], 90);           // turn the landscape timeline page upright
  setDeleted([2], true);     // drop page 3
  moveTo(4, 1);              // bring the closing page forward
  selected = new Set([1]);
  render();
  await save({ download: false });
  await thumbsIdle();
};

export { handleFiles, save };

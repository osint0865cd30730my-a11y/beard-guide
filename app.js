import { FaceLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';
import { toPx, anchorPoint, resolvePoint, defaultLines, tracePath, distToSegment } from './face.js';

const $ = (s) => document.querySelector(s);
const STORE = 'beardguide.templates.v1';
const COLORS = ['#3ee6c4', '#ffe14d', '#ff5fd2', '#ffffff'];
const LINE_COLORS = ['#3ee6c4', '#ffb547', '#7fb2ff', '#ff6b9a', '#c6f36b'];
const DEMO = new URLSearchParams(location.search).has('demo');

// ---------- Сховище ----------
function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}
function saveTemplates(list) {
  try { localStorage.setItem(STORE, JSON.stringify(list)); return true; }
  catch { toast('Не вдалося зберегти: замало місця в браузері'); return false; }
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- Розпізнавання обличчя ----------
let landmarker = null, lmMode = 'IMAGE', lmLoading = null;
async function getLandmarker(mode) {
  lmLoading ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: './vendor/face_landmarker.task', delegate },
      runningMode: 'IMAGE', numFaces: 1,
    });
    try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); }
  })().catch((e) => { lmLoading = null; throw e; });
  await lmLoading;
  if (lmMode !== mode) { await landmarker.setOptions({ runningMode: mode }); lmMode = mode; }
  return landmarker;
}

// ---------- Навігація ----------
const screens = ['home', 'capture', 'editor', 'live'];
let current = 'home';
function show(name) {
  if (current === 'capture') stopStream(capStream), (capStream = null);
  if (current === 'live') stopLive();
  screens.forEach((s) => ($('#' + s).hidden = s !== name));
  current = name;
  if (name === 'home') renderHome();
}
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('home')));

function stopStream(s) { s?.getTracks().forEach((t) => t.stop()); }
async function frontCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  return stream;
}

// ---------- Головний екран ----------
function renderHome() {
  const list = loadTemplates();
  const box = $('#templates');
  box.innerHTML = '';
  $('#empty').hidden = list.length > 0;
  list.forEach((tpl) => {
    const card = document.createElement('div');
    card.className = 'tpl';
    const cv = document.createElement('canvas');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = tpl.name;
    const small = document.createElement('small');
    small.textContent = new Date(tpl.created).toLocaleDateString('uk-UA') + ' · ' + tpl.lines.length + ' лін.';
    meta.append(b, small);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const go = Object.assign(document.createElement('button'), { className: 'go', textContent: 'Голитися' });
    const ed = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Змінити' });
    const del = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '✕', title: 'Видалити' });
    go.onclick = () => startLive(tpl);
    ed.onclick = () => openEditor(tpl.photo, tpl);
    del.onclick = () => {
      if (del.dataset.armed) {
        saveTemplates(loadTemplates().filter((t) => t.id !== tpl.id)); renderHome();
      } else {
        del.dataset.armed = '1'; del.textContent = 'Точно?';
        setTimeout(() => { delete del.dataset.armed; del.textContent = '✕'; }, 2500);
      }
    };
    btns.append(go, ed, del);
    card.append(cv, meta, btns);
    box.append(card);
    drawThumb(cv, tpl);
  });
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

async function drawThumb(cv, tpl) {
  const img = await loadImage(tpl.photo);
  cv.width = 300; cv.height = 400;
  const ctx = cv.getContext('2d');
  // кадруємо нижню частину обличчя
  const P = tpl.P;
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  const fw = Math.max(...xs) - Math.min(...xs);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = Math.max(...ys) - fw * 0.15;
  const s = cv.width / (fw * 1.6);
  ctx.setTransform(s, 0, 0, s, cv.width / 2 - cx * s, cv.height / 2 - cy * s);
  ctx.drawImage(img, 0, 0);
  tpl.lines.forEach((l) => strokeLine(ctx, l.points, l.color, 3 / s));
}

function strokeLine(ctx, pts, color, w) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); tracePath(ctx, pts);
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = w * 2.2; ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
  ctx.restore();
}

// ---------- Зйомка ----------
let capStream = null;
$('#btnNew').onclick = async () => {
  show('capture');
  try { capStream = await frontCamera($('#capVideo')); }
  catch { toast('Камера недоступна — оберіть фото з галереї'); }
};
$('#btnShot').onclick = () => {
  const v = $('#capVideo');
  if (!v.videoWidth) return toast('Камера ще не готова');
  let n = 3; const c = $('#capCount');
  c.hidden = false; c.textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n > 0) { c.textContent = n; return; }
    clearInterval(iv); c.hidden = true;
    const cv = document.createElement('canvas');
    const k = Math.min(1, 1100 / Math.max(v.videoWidth, v.videoHeight));
    cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
    // зберігаємо дзеркально, як людина бачить себе в дзеркалі
    const ctx = cv.getContext('2d');
    ctx.translate(cv.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0, cv.width, cv.height);
    openEditor(cv.toDataURL('image/jpeg', 0.85));
  }, 1000);
};
$('#capFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = await loadImage(url);
  const k = Math.min(1, 1100 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(url);
  openEditor(cv.toDataURL('image/jpeg', 0.85));
};

// ---------- Редактор ----------
const ed = { img: null, P: null, lines: [], active: 0, sel: -1, drag: null, tpl: null, view: null };

async function openEditor(photo, tpl = null) {
  show('editor');
  ed.tpl = tpl; ed.sel = -1; ed.active = 0; ed.drag = null;
  $('#tplName').value = tpl?.name || 'Мій контур';
  $('#edBusy').hidden = false;
  ed.img = await loadImage(photo);
  ed.photo = photo;
  try {
    const lm = await getLandmarker('IMAGE');
    const r = lm.detect(ed.img);
    if (!r.faceLandmarks?.length) {
      $('#edBusy').hidden = true;
      toast('Обличчя не знайдено. Потрібне чітке фото анфас.', 3500);
      return show('home');
    }
    ed.P = toPx(r.faceLandmarks[0], ed.img.width, ed.img.height);
  } catch (err) {
    console.error(err);
    $('#edBusy').hidden = true;
    toast('Не вдалося запустити розпізнавання обличчя', 3500);
    return show('home');
  }
  ed.lines = tpl
    ? tpl.lines.map((l) => ({ ...l, points: l.points.map((p) => [...p]) }))
    : withColors(defaultLines(ed.P));
  $('#edBusy').hidden = true;
  renderChips(); layoutEditor();
}

function withColors(lines) {
  return lines.map((l, i) => ({
    ...l, color: LINE_COLORS[i % LINE_COLORS.length],
    shave: l.id === 'neck' ? 'down' : l.id.startsWith('cheek') ? 'up' : null,
  }));
}

function renderChips() {
  const box = $('#lineChips'); box.innerHTML = '';
  ed.lines.forEach((l, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === ed.active ? ' on' : '');
    b.style.setProperty('--c', l.color);
    b.innerHTML = '<i></i>';
    b.append(lineLabel(l));
    b.onclick = () => { ed.active = i; ed.sel = -1; renderChips(); drawEditor(); };
    box.append(b);
  });
  const l = ed.lines[ed.active];
  $('#btnDelLine').disabled = !l || ed.lines.length <= 1;
  $('#btnDelPt').disabled = !(l && ed.sel >= 0 && l.points.length > 2);
}

function lineLabel(l) {
  if (l.id === 'neck') return 'Лінія шиї';
  if (l.id.startsWith('cheek')) {
    // на фото "ліва" сторона кадру — це права щока людини, якщо фото не дзеркальне;
    // тому підписуємо за кадром, як людина бачить себе в дзеркалі
    const cx = l.points.reduce((s, p) => s + p[0], 0) / l.points.length;
    return cx < ed.P[1][0] ? 'Щока ліворуч' : 'Щока праворуч';
  }
  return l.name || 'Лінія';
}

const edCanvas = $('#edCanvas');
function layoutEditor() {
  const r = edCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  edCanvas.width = Math.round(r.width * dpr); edCanvas.height = Math.round(r.height * dpr);
  const iw = ed.img.width, ih = ed.img.height;
  // масштабуємо так, щоб нижня половина обличчя займала екран
  const xs = ed.P.map((p) => p[0]), ys = ed.P.map((p) => p[1]);
  const fw = Math.max(...xs) - Math.min(...xs);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = Math.max(...ys) - fw * 0.05;
  const fit = Math.min(r.width / iw, r.height / ih);
  const s = Math.max(fit, Math.min(r.width / (fw * 1.45), r.height / (fw * 1.9)));
  ed.view = { s, ox: r.width / 2 - cx * s, oy: r.height / 2 - cy * s, dpr, w: r.width, h: r.height };
  drawEditor();
}
window.addEventListener('resize', () => { if (current === 'editor' && ed.img) layoutEditor(); });

function drawScene(ctx, s, ox, oy, lineW) {
  ctx.setTransform(s, 0, 0, s, ox, oy);
  ctx.drawImage(ed.img, 0, 0);
  ed.lines.forEach((l, i) => {
    ctx.globalAlpha = i === ed.active ? 1 : 0.6;
    strokeLine(ctx, l.points, l.color, lineW / s);
  });
  ctx.globalAlpha = 1;
}

function drawEditor() {
  const ctx = edCanvas.getContext('2d');
  const { s, ox, oy, dpr, w, h } = ed.view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, edCanvas.width, edCanvas.height);
  drawScene(ctx, s * dpr, ox * dpr, oy * dpr, 3 * dpr);
  // точки активної лінії
  const l = ed.lines[ed.active];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  l?.points.forEach((p, i) => {
    const x = p[0] * s + ox, y = p[1] * s + oy;
    ctx.beginPath(); ctx.arc(x, y, i === ed.sel ? 11 : 8, 0, Math.PI * 2);
    ctx.fillStyle = i === ed.sel ? l.color : 'rgba(0,0,0,.6)'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = l.color; ctx.stroke();
  });
  // лупа під час перетягування
  if (ed.drag) {
    const p = l.points[ed.drag.i];
    const R = 62, Z = 3;
    const fx = p[0] * s + ox, fy = p[1] * s + oy;
    const lx = fx < w / 2 ? w - R - 12 : R + 12, ly = R + 12;
    ctx.save();
    ctx.beginPath(); ctx.arc(lx * dpr, ly * dpr, R * dpr, 0, Math.PI * 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clip();
    const zs = s * Z * dpr;
    drawScene(ctx, zs, lx * dpr - p[0] * zs, ly * dpr - p[1] * zs, 2 * dpr);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lx - 8, ly); ctx.lineTo(lx + 8, ly); ctx.moveTo(lx, ly - 8); ctx.lineTo(lx, ly + 8);
    ctx.strokeStyle = l.color; ctx.stroke();
  }
}

function evPoint(e) {
  const r = edCanvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function toImg(sp) { const { s, ox, oy } = ed.view; return [(sp[0] - ox) / s, (sp[1] - oy) / s]; }
function toScr(p) { const { s, ox, oy } = ed.view; return [p[0] * s + ox, p[1] * s + oy]; }

edCanvas.addEventListener('pointerdown', (e) => {
  if (!ed.view) return;
  const sp = evPoint(e);
  // 1) точка будь-якої лінії (активна має пріоритет)
  const order = [ed.active, ...ed.lines.map((_, i) => i).filter((i) => i !== ed.active)];
  for (const li of order) {
    const pts = ed.lines[li].points;
    for (let i = 0; i < pts.length; i++) {
      const q = toScr(pts[i]);
      if (Math.hypot(q[0] - sp[0], q[1] - sp[1]) < 24) {
        ed.active = li; ed.sel = i;
        const ip = toImg(sp);
        ed.drag = { i, dx: pts[i][0] - ip[0], dy: pts[i][1] - ip[1] };
        edCanvas.setPointerCapture(e.pointerId);
        renderChips(); drawEditor(); return;
      }
    }
  }
  // 2) відрізок лінії — вставляємо нову точку
  for (const li of order) {
    const pts = ed.lines[li].points;
    for (let i = 0; i < pts.length - 1; i++) {
      const { d } = distToSegment(sp, toScr(pts[i]), toScr(pts[i + 1]));
      if (d < 16) {
        pts.splice(i + 1, 0, toImg(sp));
        ed.active = li; ed.sel = i + 1; ed.drag = { i: i + 1, dx: 0, dy: 0 };
        edCanvas.setPointerCapture(e.pointerId);
        renderChips(); drawEditor(); return;
      }
    }
  }
  ed.sel = -1; renderChips(); drawEditor();
});
edCanvas.addEventListener('pointermove', (e) => {
  if (!ed.drag) return;
  const ip = toImg(evPoint(e));
  ed.lines[ed.active].points[ed.drag.i] = [ip[0] + ed.drag.dx, ip[1] + ed.drag.dy];
  drawEditor();
});
const endDrag = () => { if (ed.drag) { ed.drag = null; drawEditor(); } };
edCanvas.addEventListener('pointerup', endDrag);
edCanvas.addEventListener('pointercancel', endDrag);

$('#btnDelPt').onclick = () => {
  const l = ed.lines[ed.active];
  if (ed.sel >= 0 && l.points.length > 2) { l.points.splice(ed.sel, 1); ed.sel = -1; renderChips(); drawEditor(); }
};
$('#btnAddLine').onclick = () => {
  // нова лінія — горизонтальний відрізок під носом (наприклад, для вусів)
  const P = ed.P;
  const a = [P[61][0], P[2][1] + (P[0][1] - P[2][1]) * 0.4], b = [P[291][0], a[1]];
  const n = ed.lines.filter((l) => l.id.startsWith('custom')).length + 1;
  ed.lines.push({ id: 'custom' + Date.now(), name: 'Лінія ' + n, color: LINE_COLORS[ed.lines.length % LINE_COLORS.length], shave: null,
    points: [a, [(a[0] + b[0]) / 2, a[1]], b] });
  ed.active = ed.lines.length - 1; ed.sel = -1; renderChips(); drawEditor();
};
$('#btnDelLine').onclick = () => {
  if (ed.lines.length <= 1) return;
  ed.lines.splice(ed.active, 1); ed.active = 0; ed.sel = -1; renderChips(); drawEditor();
};
$('#btnReset').onclick = () => {
  ed.lines = withColors(defaultLines(ed.P)); ed.active = 0; ed.sel = -1; renderChips(); drawEditor();
  toast('Лінії повернуто до автоматичних');
};

$('#btnSave').onclick = () => {
  const P = ed.P;
  const round = (p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  const tpl = {
    id: ed.tpl?.id || 't' + Date.now(),
    name: $('#tplName').value.trim() || 'Мій контур',
    created: ed.tpl?.created || Date.now(),
    photo: ed.photo,
    P: P.map(round),
    lines: ed.lines.map((l) => ({
      id: l.id, name: l.name, color: l.color, shave: l.shave,
      points: l.points.map(round),
      anchors: l.points.map((p) => anchorPoint(p, P)),
    })),
  };
  const list = loadTemplates().filter((t) => t.id !== tpl.id);
  list.unshift(tpl);
  if (saveTemplates(list)) { toast('Контур збережено'); show('home'); }
};

// ---------- Живий режим ----------
const live = {
  tpl: null, stream: null, raf: 0, smooth: null, mirror: true, color: -1, zone: false,
  frozen: false, wake: null, src: null, demoImg: null, lastSeen: 0, width: 3,
};
const lc = $('#liveCanvas');

async function startLive(tpl) {
  show('live');
  live.tpl = tpl; live.smooth = null; live.frozen = false; live.lastSeen = 0;
  $('#btnFreeze').textContent = '❚❚';
  drawThumb($('#liveThumb'), tpl);
  setStatus('Запуск камери…');
  try {
    if (DEMO) {
      live.demoImg = await loadImage(tpl.photo);
      live.src = document.createElement('canvas');
      live.src.width = live.demoImg.width; live.src.height = live.demoImg.height;
    } else {
      live.stream = await frontCamera($('#liveVideo'));
      live.src = $('#liveVideo');
    }
  } catch {
    setStatus('Немає доступу до камери', 'warn');
    return;
  }
  setStatus('Завантаження моделі…');
  try { await getLandmarker('VIDEO'); }
  catch { setStatus('Розпізнавання не запустилось', 'warn'); return; }
  try { live.wake = await navigator.wakeLock?.request('screen'); } catch {}
  loop();
}

function stopLive() {
  cancelAnimationFrame(live.raf);
  stopStream(live.stream); live.stream = null;
  live.wake?.release?.().catch(() => {}); live.wake = null;
}

function setStatus(text, cls = '') {
  const s = $('#liveStatus'); s.textContent = text; s.className = 'status ' + cls;
}

let lastTs = 0;
function loop() {
  live.raf = requestAnimationFrame(loop);
  if (live.frozen) return;
  const src = live.src;
  let sw, sh;
  if (DEMO) {
    // імітація руху голови для перевірки без камери
    const t = performance.now() / 1000, img = live.demoImg, c = src.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = '#111'; c.fillRect(0, 0, src.width, src.height);
    c.translate(src.width / 2 + Math.sin(t * 0.9) * src.width * 0.06, src.height / 2 + Math.sin(t * 0.6) * src.height * 0.03);
    c.rotate(Math.sin(t * 0.7) * 0.15); c.scale(1 + Math.sin(t * 0.5) * 0.06, 1 + Math.sin(t * 0.5) * 0.06);
    c.drawImage(img, -img.width / 2, -img.height / 2);
    sw = src.width; sh = src.height;
  } else {
    if (src.readyState < 2) return;
    sw = src.videoWidth; sh = src.videoHeight;
  }

  const r = lc.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (lc.width !== W || lc.height !== H) { lc.width = W; lc.height = H; }

  let ts = performance.now(); if (ts <= lastTs) ts = lastTs + 1; lastTs = ts;
  let res = null;
  try { res = landmarker.detectForVideo(src, ts); } catch (e) { console.warn(e); }
  const raw = res?.faceLandmarks?.[0];
  if (raw) {
    const P = toPx(raw, sw, sh);
    if (!live.smooth) live.smooth = P;
    else {
      const a = 0.55;
      for (let i = 0; i < P.length; i++) {
        live.smooth[i][0] += (P[i][0] - live.smooth[i][0]) * a;
        live.smooth[i][1] += (P[i][1] - live.smooth[i][1]) * a;
      }
    }
    live.lastSeen = ts;
  }

  const ctx = lc.getContext('2d');
  const s = Math.max(W / sw, H / sh);
  const ox = (W - sw * s) / 2, oy = (H - sh * s) / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (live.mirror) ctx.setTransform(-s, 0, 0, s, W - ox, oy);
  else ctx.setTransform(s, 0, 0, s, ox, oy);
  ctx.drawImage(src, 0, 0, sw, sh);

  const fresh = ts - live.lastSeen < 400;
  if (live.smooth && fresh) {
    const P = live.smooth;
    const lw = (live.width * dpr) / s;
    if (live.zone) drawZones(ctx, P);
    live.tpl.lines.forEach((l) => {
      const pts = l.anchors.map((a) => resolvePoint(a, P));
      strokeLine(ctx, pts, live.color < 0 ? l.color : COLORS[live.color], lw);
    });
    status(P, sw, s, W);
  } else {
    setStatus('Обличчя не видно — подивіться в камеру', 'warn');
  }
}

function status(P, sw, s, W) {
  const halfW = Math.hypot(P[454][0] - P[234][0], P[454][1] - P[234][1]) / 2;
  const mid = (P[234][0] + P[454][0]) / 2;
  const yaw = (P[1][0] - mid) / halfW;
  const faceOnScreen = (halfW * 2 * s) / W;
  if (faceOnScreen < 0.3) setStatus('Наблизьте телефон до обличчя', 'warn');
  else if (Math.abs(yaw) > 0.45) setStatus('Сильний поворот — лінії менш точні', 'warn');
  else setStatus('Контур на місці', 'ok');
}

// Штрихування зони, яку треба голити: нижче лінії шиї та вище ліній щік.
function drawZones(ctx, P) {
  const eyes = [(P[33][0] + P[263][0]) / 2, (P[33][1] + P[263][1]) / 2];
  const h = Math.hypot(P[152][0] - eyes[0], P[152][1] - eyes[1]);
  const down = [(P[152][0] - eyes[0]) / h, (P[152][1] - eyes[1]) / h];
  ctx.save();
  ctx.fillStyle = 'rgba(255,90,90,.22)';
  live.tpl.lines.forEach((l) => {
    if (!l.shave) return;
    const pts = l.anchors.map((a) => resolvePoint(a, P));
    const k = l.shave === 'down' ? h * 0.7 : -h * 0.22;
    ctx.beginPath(); tracePath(ctx, pts);
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0] + down[0] * k, pts[i][1] + down[1] * k);
    ctx.closePath(); ctx.fill();
  });
  ctx.restore();
}

$('#btnMirror').onclick = (e) => { live.mirror = !live.mirror; e.target.classList.toggle('on', live.mirror); };
$('#btnColor').onclick = (e) => {
  live.color = live.color + 1 >= COLORS.length ? -1 : live.color + 1;
  e.target.classList.toggle('on', live.color >= 0);
  e.target.textContent = live.color < 0 ? 'Колір' : 'Колір ' + (live.color + 1);
};
$('#btnZone').onclick = (e) => { live.zone = !live.zone; e.target.classList.toggle('on', live.zone); };
$('#btnFreeze').onclick = (e) => {
  live.frozen = !live.frozen; e.target.textContent = live.frozen ? '▶' : '❚❚';
  if (live.frozen) setStatus('Пауза — кадр зафіксовано');
};
$('#lineWidth').oninput = (e) => (live.width = +e.target.value);
document.addEventListener('visibilitychange', async () => {
  if (current === 'live' && document.visibilityState === 'visible' && !live.wake) {
    try { live.wake = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

// ---------- Старт ----------
if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
show('home');
// модель завантажуємо заздалегідь, щоб редактор відкрився швидше
setTimeout(() => getLandmarker('IMAGE').catch(() => {}), 500);

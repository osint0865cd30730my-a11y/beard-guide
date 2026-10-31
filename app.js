import { FaceLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';
import { toPx, anchorPoint, resolvePoint, tracePath, distToSegment } from './face.js';
import { analyzeBeard, headPose } from './analyze.js';

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
  if (current === 'capture') stopCapture();
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
    small.textContent = new Date(tpl.created).toLocaleDateString('uk-UA') + ' · ' + (tpl.photos?.length || 1) + ' фото · ' + tpl.lines.length + ' лін.';
    meta.append(b, small);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const go = Object.assign(document.createElement('button'), { className: 'go', textContent: 'Голитися' });
    const ed = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Змінити' });
    const del = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '✕', title: 'Видалити' });
    go.onclick = () => startLive(tpl);
    ed.onclick = () => openEditor({ photos: tpl.photos || [{ role: 'front', data: tpl.photo, P: tpl.P }], lines: tpl.lines, tpl });
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

// ---------- Зйомка чотирьох фото ----------
// Кожен кадр має свою перевірку пози за орієнтирами відео. Коли поза правильна
// 1,2 с поспіль, іде відлік і кадр знімається сам; кнопка «Зняти зараз» — без перевірки.
const STEPS = [
  { role: 'front', title: 'Анфас', icon: '🙂', hint: 'Дивіться прямо в камеру, обличчя в овалі',
    check: (p) => Math.abs(p.yaw) < 0.18 && Math.abs(p.pitch) < 0.2, fix: 'Поверніть обличчя прямо до камери' },
  { role: 'left', title: 'Лівий бік', icon: '◀', hint: 'Поверніть голову праворуч, щоб камера бачила ліву щоку',
    check: (p) => p.near === 'left' && Math.abs(p.yaw) > 0.3 && Math.abs(p.yaw) < 0.95,
    fix: 'Поверніть голову праворуч приблизно на 40°' },
  { role: 'right', title: 'Правий бік', icon: '▶', hint: 'Поверніть голову ліворуч, щоб камера бачила праву щоку',
    check: (p) => p.near === 'right' && Math.abs(p.yaw) > 0.3 && Math.abs(p.yaw) < 0.95,
    fix: 'Поверніть голову ліворуч приблизно на 40°' },
  { role: 'chin', title: 'Знизу', icon: '🔼', hint: 'Підніміть підборіддя і тримайте телефон нижче, щоб було видно шию',
    check: (p) => p.pitch > 0.2 && Math.abs(p.yaw) < 0.3, fix: 'Підніміть підборіддя вище' },
];
const cap = { stream: null, raf: 0, step: 0, photos: {}, okSince: 0, counting: false, busy: false, lastTs: 0 };

$('#btnNew').onclick = async () => {
  cap.photos = {}; cap.step = 0; cap.okSince = 0; cap.counting = false;
  show('capture'); renderSteps();
  $('#capPose').textContent = 'Запуск камери…'; $('#capPose').className = 'pose';
  try { cap.stream = await frontCamera($('#capVideo')); }
  catch { setPose('Камера недоступна — додайте фото з галереї', 'warn'); return; }
  try { await getLandmarker('VIDEO'); } catch { setPose('Розпізнавання не запустилось', 'warn'); return; }
  captureLoop();
};

function stopCapture() {
  cancelAnimationFrame(cap.raf); cap.raf = 0;
  stopStream(cap.stream); cap.stream = null;
}

function setPose(text, cls = '') { const el = $('#capPose'); el.textContent = text; el.className = 'pose ' + cls; }

function renderSteps() {
  const box = $('#capSteps'); box.innerHTML = '';
  STEPS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'step' + (i === cap.step ? ' on' : '') + (cap.photos[s.role] ? ' done' : '');
    const ph = document.createElement('div'); ph.className = 'ph';
    if (cap.photos[s.role]) { const im = new Image(); im.src = cap.photos[s.role]; im.alt = s.title; ph.append(im); }
    else ph.textContent = s.icon;
    const lab = document.createElement('span'); lab.textContent = s.title;
    b.append(ph, lab);
    b.onclick = () => { cap.step = i; cap.okSince = 0; renderSteps(); };
    box.append(b);
  });
  const s = STEPS[cap.step];
  $('#capTitle').textContent = `Фото ${cap.step + 1} з 4 · ${s.title}`;
  $('#capHint').textContent = s.hint;
  const all = STEPS.every((st) => cap.photos[st.role]);
  $('#btnAnalyze').hidden = !all;
  $('#btnShot').hidden = all;
}

function captureLoop() {
  cap.raf = requestAnimationFrame(captureLoop);
  const v = $('#capVideo');
  if (v.readyState < 2 || cap.counting || cap.busy) return;
  let ts = performance.now(); if (ts <= cap.lastTs) ts = cap.lastTs + 1; cap.lastTs = ts;
  let res = null;
  try { res = landmarker.detectForVideo(v, ts); } catch {}
  const lm = res?.faceLandmarks?.[0];
  if (!lm) { setPose('Обличчя не видно', 'warn'); cap.okSince = 0; return; }
  const pose = headPose(lm);
  if (pose.faceWidth < 0.22) { setPose('Наблизьте телефон до обличчя', 'warn'); cap.okSince = 0; return; }
  const step = STEPS[cap.step];
  if (!step.check(pose)) { setPose(step.fix, ''); cap.okSince = 0; return; }
  if (!cap.okSince) cap.okSince = ts;
  const held = ts - cap.okSince;
  setPose('✓ Тримайте так', 'ok');
  if (held > 1200) shoot(true);
}

function grabFrame(v) {
  const cv = document.createElement('canvas');
  const k = Math.min(1, 900 / Math.max(v.videoWidth, v.videoHeight));
  cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
  // зберігаємо дзеркально, як людина бачить себе в дзеркалі
  const ctx = cv.getContext('2d');
  ctx.translate(cv.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(v, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.8);
}

function shoot(auto) {
  const v = $('#capVideo');
  if (!v.videoWidth) return toast('Камера ще не готова');
  if (cap.counting) return;
  cap.counting = true;
  let n = auto ? 2 : 3; const c = $('#capCount');
  c.hidden = false; c.textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n > 0) { c.textContent = n; return; }
    clearInterval(iv); c.hidden = true; cap.counting = false; cap.okSince = 0;
    acceptPhoto(grabFrame(v));
  }, 1000);
}
$('#btnShot').onclick = () => shoot(false);

function acceptPhoto(data) {
  cap.photos[STEPS[cap.step].role] = data;
  const next = STEPS.findIndex((s) => !cap.photos[s.role]);
  if (next >= 0) cap.step = next;
  renderSteps();
  if (next < 0) setPose('Усі 4 фото є — натисніть «Аналізувати»', 'ok');
}

$('#capFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = await loadImage(url);
  const k = Math.min(1, 900 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  URL.revokeObjectURL(url);
  acceptPhoto(cv.toDataURL('image/jpeg', 0.8));
};

$('#btnAnalyze').onclick = async () => {
  cap.busy = true;
  const photos = STEPS.map((s) => ({ role: s.role, data: cap.photos[s.role] }));
  stopCapture();
  openEditor({ photos });
};

// Розпізнає обличчя на кожному фото. Повертає [{role, data, img, P, landmarks}];
// P = null, якщо обличчя на фото не знайдено. Кидає помилку, якщо його немає на анфасі.
async function loadPhotos(photos, onProgress) {
  const lm = await getLandmarker('IMAGE');
  const out = [];
  for (const p of photos) {
    onProgress?.(`Шукаю обличчя: ${STEPS.find((s) => s.role === p.role)?.title || p.role}…`);
    const img = await loadImage(p.data);
    let landmarks = null;
    if (p.P && p.landmarks) landmarks = p.landmarks;
    else landmarks = lm.detect(img).faceLandmarks?.[0] || null;
    if (!landmarks && p.role === 'front') throw new Error('На фото анфас не знайдено обличчя. Перезніміть його.');
    out.push({ role: p.role, data: p.data, img, landmarks, P: landmarks ? toPx(landmarks, img.width, img.height) : null });
  }
  return out;
}

// Будує лінії за всіма фото, на яких є обличчя. Повертає {lines (у пікселях анфасу), report, debug}.
async function runAnalysis(loaded, onProgress) {
  const detected = loaded.filter((p) => p.P);
  const front = detected.find((p) => p.role === 'front');
  onProgress?.('Шукаю межу бороди…');
  await new Promise((r) => setTimeout(r, 30));
  const { lines, report, debug } = analyzeBeard(detected, front.P);
  report.skipped = loaded.length - detected.length;
  return { lines, report, debug };
}

// ---------- Редактор ----------
// Контур зберігається один — як прив'язки до сітки обличчя (anchors). На кожному
// з чотирьох фото він показується через орієнтири саме цього фото, і правка на
// будь-якому фото змінює той самий спільний контур.
const ed = { photos: [], cur: 0, lines: [], active: 0, sel: -1, drag: null, tpl: null, view: null, auto: null };

const curPhoto = () => ed.photos[ed.cur];
const frontPhoto = () => ed.photos.find((p) => p.role === 'front') || ed.photos[0];
const linePts = (l, P = curPhoto().P) => l.anchors.map((a) => resolvePoint(a, P));
const toAnchors = (points, P) => points.map((p) => anchorPoint(p, P));

// draft: { photos: [{role, data, P?, landmarks?}], lines? (з anchors), tpl? }. Без lines — запускає аналіз.
async function openEditor(draft) {
  show('editor');
  ed.tpl = draft.tpl || null; ed.sel = -1; ed.active = 0; ed.drag = null; ed.auto = null;
  $('#tplName').value = draft.tpl?.name || 'Мій контур';
  $('#edReport').textContent = '';
  const busy = $('#edBusy'); busy.hidden = false; busy.textContent = 'Шукаю обличчя…';
  try {
    ed.photos = await loadPhotos(draft.photos, (t) => (busy.textContent = t));
    ed.cur = ed.photos.indexOf(frontPhoto());
    if (draft.lines?.every((l) => l.anchors)) {
      ed.lines = draft.lines.map((l) => ({ ...l, anchors: l.anchors.map((a) => ({ t: a.t, w: [...a.w] })) }));
    } else {
      const r = await runAnalysis(ed.photos, (t) => (busy.textContent = t));
      ed.auto = r;
      ed.lines = withColors(r.lines).map((l) => ({ ...l, anchors: toAnchors(l.points, frontPhoto().P) }));
      showReport(r.report);
    }
  } catch (err) {
    console.error(err);
    busy.hidden = true; cap.busy = false;
    toast(err.message || 'Не вдалося проаналізувати фото', 4000);
    return show('home');
  }
  busy.hidden = true; cap.busy = false;
  renderPhotoTabs(); renderChips(); layoutEditor();
}

function renderPhotoTabs() {
  const box = $('#edPhotos'); box.innerHTML = '';
  box.hidden = ed.photos.length < 2;
  ed.photos.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'step' + (i === ed.cur ? ' on' : '') + (p.P ? '' : ' off');
    b.disabled = !p.P;
    const ph = document.createElement('div'); ph.className = 'ph';
    const im = new Image(); im.src = p.data; im.alt = ''; ph.append(im);
    const lab = document.createElement('span');
    lab.textContent = (STEPS.find((s) => s.role === p.role)?.title || p.role) + (p.P ? '' : ' · без обличчя');
    b.append(ph, lab);
    b.onclick = () => { ed.cur = i; ed.sel = -1; ed.drag = null; renderPhotoTabs(); renderChips(); layoutEditor(); };
    box.append(b);
  });
}

function showReport(r) {
  const parts = [];
  parts.push(r.neck ? 'шию знайдено' : 'шия: типова лінія');
  const cheeks = (r.cheekA ? 1 : 0) + (r.cheekB ? 1 : 0);
  parts.push(cheeks === 2 ? 'обидві щоки знайдено' : cheeks === 1 ? 'одна щока знайдена' : 'щоки: типові лінії');
  if (r.skipped) parts.push(`${r.skipped} фото без обличчя пропущено`);
  $('#edReport').textContent = `Аналіз ${r.photos} фото: ${parts.join(', ')}. Перевірте контур на кожному фото і підправте точки.`;
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
  $('#btnDelPt').disabled = !(l && ed.sel >= 0 && l.anchors.length > 2);
}

function lineLabel(l) {
  if (l.id === 'neck') return 'Лінія шиї';
  if (l.id.startsWith('cheek')) {
    // підписуємо за кадром анфасу, як людина бачить себе в дзеркалі
    const P = frontPhoto().P, pts = linePts(l, P);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    return cx < P[1][0] ? 'Щока ліворуч' : 'Щока праворуч';
  }
  return l.name || 'Лінія';
}

const edCanvas = $('#edCanvas');
function layoutEditor() {
  const { img, P } = curPhoto();
  const r = edCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  edCanvas.width = Math.round(r.width * dpr); edCanvas.height = Math.round(r.height * dpr);
  const iw = img.width, ih = img.height;
  // масштабуємо так, щоб нижня половина обличчя займала екран
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  const fw = Math.max(...xs) - Math.min(...xs);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = Math.max(...ys) - fw * 0.05;
  const fit = Math.min(r.width / iw, r.height / ih);
  const s = Math.max(fit, Math.min(r.width / (fw * 1.45), r.height / (fw * 1.9)));
  ed.view = { s, ox: r.width / 2 - cx * s, oy: r.height / 2 - cy * s, dpr, w: r.width, h: r.height };
  drawEditor();
}
window.addEventListener('resize', () => { if (current === 'editor' && ed.photos.length) layoutEditor(); });

function drawScene(ctx, s, ox, oy, lineW) {
  ctx.setTransform(s, 0, 0, s, ox, oy);
  ctx.drawImage(curPhoto().img, 0, 0);
  ed.lines.forEach((l, i) => {
    ctx.globalAlpha = i === ed.active ? 1 : 0.6;
    strokeLine(ctx, linePts(l), l.color, lineW / s);
  });
  ctx.globalAlpha = 1;
}

function drawEditor() {
  const ctx = edCanvas.getContext('2d');
  const { s, ox, oy, dpr, w } = ed.view;
  const P = curPhoto().P;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, edCanvas.width, edCanvas.height);
  drawScene(ctx, s * dpr, ox * dpr, oy * dpr, 3 * dpr);
  // налагодження (тільки ?demo, на анфасі): оцінка «бородатості» кожного орієнтира
  if (DEMO && ed.auto?.debug && curPhoto().role === 'front') {
    const { scores, thr } = ed.auto.debug;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scores.forEach((sc, i) => {
      const x = P[i][0] * s + ox, y = P[i][1] * s + oy;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = sc > thr ? `rgba(255,60,60,${0.4 + 0.6 * sc})` : `rgba(80,160,255,${0.3 + 0.6 * (1 - sc)})`;
      ctx.fill();
    });
  }
  // точки активної лінії
  const l = ed.lines[ed.active];
  const pts = l ? linePts(l) : [];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pts.forEach((p, i) => {
    const x = p[0] * s + ox, y = p[1] * s + oy;
    ctx.beginPath(); ctx.arc(x, y, i === ed.sel ? 11 : 8, 0, Math.PI * 2);
    ctx.fillStyle = i === ed.sel ? l.color : 'rgba(0,0,0,.6)'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = l.color; ctx.stroke();
  });
  // лупа під час перетягування: збільшена ділянка з точкою рівно в центрі
  if (ed.drag) {
    const p = pts[ed.drag.i];
    const R = 64, Z = 2.5;
    const fx = p[0] * s + ox;
    const lx = fx < w / 2 ? w - R - 12 : R + 12, ly = R + 12;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath(); ctx.arc(lx * dpr, ly * dpr, R * dpr, 0, Math.PI * 2); ctx.clip();
    const zs = s * Z * dpr;
    drawScene(ctx, zs, lx * dpr - p[0] * zs, ly * dpr - p[1] * zs, 2 * dpr);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2);
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(lx - 16, ly); ctx.lineTo(lx - 7, ly); ctx.moveTo(lx + 7, ly); ctx.lineTo(lx + 16, ly);
    ctx.moveTo(lx, ly - 16); ctx.lineTo(lx, ly - 7); ctx.moveTo(lx, ly + 7); ctx.lineTo(lx, ly + 16);
    ctx.lineWidth = 2; ctx.strokeStyle = l.color; ctx.stroke();
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
  const P = curPhoto().P;
  // 1) точка будь-якої лінії (активна має пріоритет)
  const order = [ed.active, ...ed.lines.map((_, i) => i).filter((i) => i !== ed.active)];
  for (const li of order) {
    const pts = linePts(ed.lines[li]);
    for (let i = 0; i < pts.length; i++) {
      const q = toScr(pts[i]);
      if (Math.hypot(q[0] - sp[0], q[1] - sp[1]) < 24) {
        ed.active = li; ed.sel = i;
        const ip = toImg(sp);
        ed.drag = { i, dx: pts[i][0] - ip[0], dy: pts[i][1] - ip[1] };
        try { edCanvas.setPointerCapture(e.pointerId); } catch {}
        renderChips(); drawEditor(); return;
      }
    }
  }
  // 2) відрізок лінії — вставляємо нову точку
  for (const li of order) {
    const pts = linePts(ed.lines[li]);
    for (let i = 0; i < pts.length - 1; i++) {
      const { d } = distToSegment(sp, toScr(pts[i]), toScr(pts[i + 1]));
      if (d < 16) {
        ed.lines[li].anchors.splice(i + 1, 0, anchorPoint(toImg(sp), P));
        ed.active = li; ed.sel = i + 1; ed.drag = { i: i + 1, dx: 0, dy: 0 };
        try { edCanvas.setPointerCapture(e.pointerId); } catch {}
        renderChips(); drawEditor(); return;
      }
    }
  }
  ed.sel = -1; renderChips(); drawEditor();
});
edCanvas.addEventListener('pointermove', (e) => {
  if (!ed.drag) return;
  const ip = toImg(evPoint(e));
  ed.lines[ed.active].anchors[ed.drag.i] = anchorPoint([ip[0] + ed.drag.dx, ip[1] + ed.drag.dy], curPhoto().P);
  drawEditor();
});
const endDrag = () => { if (ed.drag) { ed.drag = null; drawEditor(); } };
edCanvas.addEventListener('pointerup', endDrag);
edCanvas.addEventListener('pointercancel', endDrag);

$('#btnDelPt').onclick = () => {
  const l = ed.lines[ed.active];
  if (ed.sel >= 0 && l.anchors.length > 2) { l.anchors.splice(ed.sel, 1); ed.sel = -1; renderChips(); drawEditor(); }
};
$('#btnAddLine').onclick = () => {
  // нова лінія — горизонтальний відрізок під носом (наприклад, для вусів)
  const P = curPhoto().P;
  const a = [P[61][0], P[2][1] + (P[0][1] - P[2][1]) * 0.4], b = [P[291][0], a[1]];
  const n = ed.lines.filter((l) => l.id.startsWith('custom')).length + 1;
  ed.lines.push({ id: 'custom' + Date.now(), name: 'Лінія ' + n, color: LINE_COLORS[ed.lines.length % LINE_COLORS.length], shave: null,
    anchors: toAnchors([a, [(a[0] + b[0]) / 2, a[1]], b], P) });
  ed.active = ed.lines.length - 1; ed.sel = -1; renderChips(); drawEditor();
};
$('#btnDelLine').onclick = () => {
  if (ed.lines.length <= 1) return;
  ed.lines.splice(ed.active, 1); ed.active = 0; ed.sel = -1; renderChips(); drawEditor();
};
$('#btnReset').onclick = async () => {
  if (!ed.auto) {
    const busy = $('#edBusy'); busy.hidden = false;
    try { ed.auto = await runAnalysis(ed.photos, (t) => (busy.textContent = t)); }
    catch (err) { busy.hidden = true; return toast(err.message || 'Не вдалося проаналізувати', 4000); }
    busy.hidden = true;
  }
  ed.lines = withColors(ed.auto.lines).map((l) => ({ ...l, anchors: toAnchors(l.points, frontPhoto().P) }));
  ed.active = 0; ed.sel = -1;
  showReport(ed.auto.report); renderChips(); drawEditor();
  toast('Лінії повернуто до автоматичних');
};

$('#btnSave').onclick = () => {
  const front = frontPhoto();
  const round = (p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  const tpl = {
    id: ed.tpl?.id || 't' + Date.now(),
    name: $('#tplName').value.trim() || 'Мій контур',
    created: ed.tpl?.created || Date.now(),
    photo: front.data,
    photos: ed.photos.map((p) => ({ role: p.role, data: p.data, P: p.P?.map(round) || null,
      landmarks: p.landmarks?.map((q) => ({ x: q.x, y: q.y, z: q.z })) || null })),
    P: front.P.map(round),
    lines: ed.lines.map((l) => ({
      id: l.id, name: l.name, color: l.color, shave: l.shave,
      points: linePts(l, front.P).map(round),
      anchors: l.anchors.map((a) => ({ t: a.t, w: a.w.map((x) => Math.round(x * 10000) / 10000) })),
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

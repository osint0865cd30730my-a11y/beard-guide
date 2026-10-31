// Автоматичний пошук межі бороди за кількома фото.
//
// Ідея: для кожної точки сітки обличчя (478 орієнтирів) беремо невеликий клаптик
// пікселів і оцінюємо «бородатість» — наскільки він темніший і фактурніший за
// еталонну шкіру того самого фото (лоб, перенісся, вилиці). Оцінки з усіх фото
// зливаються за номером орієнтира, тому фото з різних ракурсів доповнюють одне
// одного: бічні дають щоки без перспективного спотворення, кадр знизу — шию.
// Далі на фронтальному фото скануємо щоки зверху вниз і шукаємо, де починається
// борода, а під щелепою — де вона закінчується.

import { toPx, defaultLines } from './face.js';

// Еталон шкіри: лоб, перенісся, спинка носа, верх щік.
const SKIN_REF = [10, 151, 9, 8, 168, 6, 197, 195, 108, 337, 69, 299, 67, 297, 109, 338, 50, 280, 101, 330, 118, 347, 117, 346];
// Губи і рот — не борода, хоч і темніші за шкіру.
const LIPS = new Set([
  0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61, 185, 40, 39, 37,
  13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78, 191, 80, 81, 82,
  12, 268, 271, 272, 407, 292, 325, 319, 403, 316, 15, 86, 180, 89, 96, 62, 183, 42, 41, 38,
  11, 302, 303, 304, 408, 306, 307, 320, 404, 315, 16, 85, 90, 77, 76, 184, 74, 73, 72,
]);
// Точки щелепи від лівого вуха до правого (для лінії шиї).
export const JAW = [361, 397, 365, 378, 152, 149, 136, 172, 132];

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Система координат обличчя: u — вбік (−1 біля одного вуха, +1 біля іншого),
// v — вниз (0 на рівні очей, 1 на підборідді).
export function faceFrame(P) {
  const eyes = [(P[33][0] + P[263][0]) / 2, (P[33][1] + P[263][1]) / 2];
  const h = dist(eyes, P[152]);
  const down = [(P[152][0] - eyes[0]) / h, (P[152][1] - eyes[1]) / h];
  const lat0 = [P[454][0] - P[234][0], P[454][1] - P[234][1]];
  const fw = Math.hypot(lat0[0], lat0[1]);
  const lat = [lat0[0] / fw, lat0[1] / fw];
  const mid = [(P[234][0] + P[454][0]) / 2, (P[234][1] + P[454][1]) / 2];
  return {
    eyes, h, down, lat, fw, halfW: fw / 2, mid,
    uv(p) {
      const dx = p[0] - eyes[0], dy = p[1] - eyes[1];
      return [((p[0] - mid[0]) * lat[0] + (p[1] - mid[1]) * lat[1]) / (fw / 2), (dx * down[0] + dy * down[1]) / h];
    },
    pt(u, v) {
      return [mid[0] + lat[0] * u * (fw / 2) + down[0] * v * h, mid[1] + lat[1] * u * (fw / 2) + down[1] * v * h];
    },
  };
}

// Поза голови за «сирими» орієнтирами відео (нормовані x, y, z).
// yaw: 0 анфас, за модулем ~0.5 при повороті на 40°. near: яка щока ближче до камери.
// pitch: >0 коли підборіддя підняте (ближче до камери, ніж лоб).
export function headPose(lm) {
  const halfW = Math.abs(lm[454].x - lm[234].x) / 2 || 1e-6;
  const midX = (lm[454].x + lm[234].x) / 2;
  const yaw = (lm[1].x - midX) / halfW;
  const near = lm[234].z < lm[454].z ? 'right' : 'left';
  const eyesY = (lm[33].y + lm[263].y) / 2;
  const fh = Math.abs(lm[152].y - eyesY) || 1e-6;
  const zPitch = (lm[10].z - lm[152].z) / fh;
  const r = (lm[1].y - eyesY) / fh; // анфас ≈ 0.5, підборіддя вгору — більше
  return { yaw, near, pitch: Math.max(zPitch * 1.2, (r - 0.52) * 2.2), faceWidth: halfW * 2 };
}

// Ознаки одного фото: функція score(x, y) у координатах зменшеного зображення.
function photoSampler(img) {
  const k = Math.min(1, 900 / Math.max(img.width, img.height));
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  // Клаптик радіуса r: середня яскравість, її розкид (фактура) і насиченість.
  const patch = (x, y, r) => {
    let n = 0, s = 0, s2 = 0, sat = 0;
    const x0 = Math.max(0, Math.round(x - r)), x1 = Math.min(w - 1, Math.round(x + r));
    const y0 = Math.max(0, Math.round(y - r)), y1 = Math.min(h - 1, Math.round(y + r));
    if (x1 < x0 || y1 < y0) return null;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const i = (yy * w + xx) * 4;
      const R = data[i], G = data[i + 1], B = data[i + 2];
      const L = 0.299 * R + 0.587 * G + 0.114 * B;
      const mx = Math.max(R, G, B);
      n++; s += L; s2 += L * L; sat += mx ? (mx - Math.min(R, G, B)) / mx : 0;
    }
    const mean = s / n;
    return { L: mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)), sat: sat / n };
  };
  return { k, w, h, patch };
}

// Аналіз одного фото: оцінка «бородатості» для кожного орієнтира нижньої частини
// обличчя (з вагами за ракурсом) і — для кадру знизу чи анфас — глибина бороди
// під кожною точкою щелепи.
function analyzePhoto(img, landmarks, role) {
  const S = photoSampler(img);
  const P = toPx(landmarks, S.w, S.h);
  const F = faceFrame(P);
  const r = Math.max(2, Math.round(F.fw * 0.012));

  const refs = SKIN_REF.map((i) => S.patch(P[i][0], P[i][1], r)).filter(Boolean);
  const Lref = Math.max(20, median(refs.map((p) => p.L)));
  const sdRef = median(refs.map((p) => p.sd));
  const satRef = median(refs.map((p) => p.sat));
  const score = (x, y) => {
    const p = S.patch(x, y, r);
    if (!p) return null;
    const dark = (Lref - p.L) / Lref;
    const texture = Math.max(0, p.sd - sdRef) / Lref;
    const redder = Math.max(0, p.sat - satRef); // губи, почервоніння — не борода
    return clamp01(1.5 * dark + 2.2 * texture - 0.8 * redder);
  };

  // Яка сторона ближча до камери (у координаті u цього фото).
  const nearU = landmarks[234].z < landmarks[454].z ? -1 : 1;
  const vertex = new Map();
  for (let i = 0; i < P.length; i++) {
    if (LIPS.has(i)) continue;
    const [u, v] = F.uv(P[i]);
    if (v < 0.3 || Math.abs(u) > 1.05) continue;
    if (v < 0.6 && Math.abs(u) < 0.4) continue; // ніс і ніздрі
    const s = score(P[i][0], P[i][1]);
    if (s === null) continue;
    let w = 0.7;
    if (role === 'left' || role === 'right') w = Math.sign(u) === nearU ? (Math.abs(u) > 0.15 ? 1 : 0.5) : 0.1;
    else if (role === 'chin') w = v > 0.75 ? 1 : 0.4;
    vertex.set(i, { s, w });
  }

  // Глибина бороди під щелепою: ідемо вниз від кожної точки щелепи.
  let neck = null;
  if (role === 'chin' || role === 'front') {
    neck = JAW.map((j) => {
      const samples = [];
      for (let k = 0.02; k <= 0.75; k += 0.025) {
        const p = F.pt(F.uv(P[j])[0], 0);
        const q = [P[j][0] + F.down[0] * k * F.h, P[j][1] + F.down[1] * k * F.h];
        const s = score(q[0], q[1]);
        samples.push({ k, s: s === null ? -1 : s });
        if (s === null) break;
        void p;
      }
      return samples;
    });
  }
  return { role, vertex, neck, Lref };
}

// Поріг Оцу: ділить оцінки на дві групи (шкіра/борода). Якщо розподіл не
// двогорбий, залишаємо помірний фіксований поріг.
function otsu(values) {
  if (values.length < 12) return 0.4;
  const bins = new Array(32).fill(0);
  values.forEach((v) => bins[Math.min(31, Math.floor(v * 32))]++);
  const total = values.length, sumAll = bins.reduce((s, c, i) => s + c * i, 0);
  let best = 0, thr = 12, wB = 0, sumB = 0;
  for (let i = 0; i < 32; i++) {
    wB += bins[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += bins[i] * i;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = i + 1; }
  }
  return Math.max(0.28, Math.min(0.6, thr / 32));
}

function smooth3(arr) {
  return arr.map((_, i) => median(arr.slice(Math.max(0, i - 1), i + 2)));
}

// Головна функція. photos: [{role, img, landmarks}], frontP: орієнтири анфас у
// пікселях повнорозмірного фронтального фото. Повертає лінії в тих самих пікселях.
export function analyzeBeard(photos, frontP) {
  const per = photos.map((p) => analyzePhoto(p.img, p.landmarks, p.role));

  // Злиття оцінок за номером орієнтира.
  const merged = new Map();
  per.forEach(({ vertex }) => vertex.forEach(({ s, w }, i) => {
    const m = merged.get(i) || { sw: 0, w: 0 };
    m.sw += s * w; m.w += w; merged.set(i, m);
  }));
  const scores = new Map([...merged].map(([i, m]) => [i, m.sw / m.w]));
  const thr = otsu([...scores.values()]);

  const F = faceFrame(frontP);
  // Інтерполяція оцінки в довільній точці фронтального фото (зважено за відстанню).
  const R = F.fw * 0.09;
  const at = (p) => {
    let sw = 0, w = 0;
    scores.forEach((s, i) => {
      const d = dist(p, frontP[i]);
      if (d > R) return;
      const k = (1 - d / R) ** 2; sw += s * k; w += k;
    });
    return w > 0.15 ? sw / w : null;
  };

  // Лінія щоки: стовпчики від вуха до кута рота, у кожному шукаємо, де
  // починається борода (три поспіль «бородаті» проби).
  const cheek = (sign) => {
    const pts = [];
    for (let c = 0; c <= 8; c++) {
      const u = sign * (0.95 - c * 0.07);
      // біля вуха починаємо нижче бакенбардів, біля рота — нижче носа
      const vStart = Math.abs(u) > 0.45 ? 0.38 : 0.6;
      let found = null, run = 0;
      for (let v = vStart; v <= 1.1; v += 0.02) {
        const s = at(F.pt(u, v));
        if (s === null) { run = 0; continue; }
        if (s > thr) { run++; if (run === 3) { found = v - 0.04; break; } }
        else run = 0;
      }
      if (found !== null) pts.push({ u, v: found });
    }
    if (pts.length < 4) return null;
    const vs = smooth3(pts.map((p) => p.v));
    const line = pts.map((p, i) => F.pt(p.u, vs[i]));
    // залишаємо 5–6 точок, щоб зручно редагувати
    const step = Math.max(1, Math.round(line.length / 5));
    const out = line.filter((_, i) => i % step === 0);
    if (out[out.length - 1] !== line[line.length - 1]) out.push(line[line.length - 1]);
    return out;
  };

  // Лінія шиї: глибина бороди під щелепою з кадру знизу (або анфас).
  const neckSrc = per.find((p) => p.role === 'chin' && p.neck) || per.find((p) => p.role === 'front' && p.neck);
  let neck = null, neckFound = 0;
  if (neckSrc) {
    const ks = neckSrc.neck.map((samples) => {
      const valid = samples.filter((x) => x.s >= 0);
      if (valid.length < 4) return null;
      const head = valid.slice(0, 3).reduce((s, x) => s + x.s, 0) / 3;
      if (head < thr) return 0.03; // під щелепою вже чисто — лінія біля краю
      let gap = 0;
      for (let i = 1; i < valid.length; i++) {
        if (valid[i].s < thr) { gap++; if (gap >= 2) return valid[i - 2].k; } else gap = 0;
      }
      return null; // борода до кінця кадру — не визначити
    });
    neckFound = ks.filter((k) => k !== null).length;
    if (neckFound >= 4) {
      const fill = median(ks.filter((k) => k !== null));
      // У кадрі знизу під щелепа видно повністю, а в анфас (і в дзеркалі під час
      // гоління) вона скорочена перспективою — тому глибину зменшуємо.
      const scale = neckSrc.role === 'chin' ? 0.6 : 1;
      const kk = smooth3(ks.map((k) => Math.min(0.4, Math.max(0.03, (k === null ? fill : k) * scale))));
      neck = JAW.map((j, i) => [frontP[j][0] + F.down[0] * kk[i] * F.h, frontP[j][1] + F.down[1] * kk[i] * F.h]);
    }
  }

  const fallback = Object.fromEntries(defaultLines(frontP).map((l) => [l.id, l.points]));
  const cheekA = cheek(-1), cheekB = cheek(1);
  const report = {
    thr: Math.round(thr * 100) / 100,
    photos: per.length,
    cheekA: !!cheekA, cheekB: !!cheekB, neck: !!neck,
    beardVertices: [...scores.values()].filter((s) => s > thr).length,
  };
  return {
    report,
    debug: { scores, thr, neck: neckSrc?.neck || null },
    lines: [
      { id: 'neck', name: 'Шия', points: neck || fallback.neck, auto: !!neck },
      { id: 'cheekA', name: 'Щока', points: cheekA || fallback.cheekA, auto: !!cheekA },
      { id: 'cheekB', name: 'Щока', points: cheekB || fallback.cheekB, auto: !!cheekB },
    ],
  };
}

// Геометрія: прив'язка точок контуру до обличчя за орієнтирами MediaPipe (478 точок, 3D).
//
// Точка контуру зберігається одним із двох способів:
//  • на сітці обличчя — {t, w}: номер трикутника повної сітки (≈880 дрібних
//    трикутників) і барицентричні ваги. Точка «приклеєна» до шкіри і їде разом
//    з нею за будь-якого повороту голови;
//  • поза сіткою (шия під щелепою) — {q}: 3D-координати в жорсткій системі
//    голови (осі будуються з верхньої частини обличчя, яка не рухається, коли
//    відкривається рот). Глибина точки уточнюється, коли її правлять на фото
//    з іншого ракурсу.

import { FaceLandmarker } from './vendor/vision_bundle.mjs';

// Трикутники сітки: у MediaPipe з'єднання йдуть трійками, кожна трійка — трикутник.
const TESS = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
export const TRIS = [];
for (let i = 0; i + 2 < TESS.length; i += 3) TRIS.push([TESS[i].start, TESS[i + 1].start, TESS[i + 2].start]);

// Контур обличчя — для оцінки глибини точок поза сіткою.
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

export function toPx(landmarks, w, h) {
  return landmarks.map((p) => [p.x * w, p.y * h]);
}
// 3D у пікселях: глибина z у MediaPipe має той самий масштаб, що й x.
export function toPx3(landmarks, w, h) {
  return landmarks.map((p) => [p.x * w, p.y * h, p.z * w]);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const mean = (P, idx) => {
  const m = [0, 0, 0];
  idx.forEach((i) => { m[0] += P[i][0]; m[1] += P[i][1]; m[2] += P[i][2]; });
  return [m[0] / idx.length, m[1] / idx.length, m[2] / idx.length];
};

// Жорстка система координат голови. Осі усереднюються за групами точок, щоб
// шум окремого орієнтира не смикав лінії.
function headFrame(P) {
  const L = mean(P, [234, 127, 93, 132]), R = mean(P, [454, 356, 323, 361]);
  const top = mean(P, [10, 151, 9, 108, 337]), low = mean(P, [2, 164, 98, 327, 97, 326]);
  const X = norm(sub(R, L));
  const yr = sub(low, top);
  const k = dot(yr, X);
  const Y = norm([yr[0] - X[0] * k, yr[1] - X[1] * k, yr[2] - X[2] * k]);
  const Z = cross(X, Y);
  const O = mean(P, [234, 454, 2, 164, 127, 356]);
  const s = Math.hypot(R[0] - L[0], R[1] - L[1], R[2] - L[2]);
  return { O, X, Y, Z, s };
}
const toLocal = (p, f) => { const d = sub(p, f.O); return [dot(d, f.X) / f.s, dot(d, f.Y) / f.s, dot(d, f.Z) / f.s]; };
const toWorld = (q, f) => [
  f.O[0] + f.s * (q[0] * f.X[0] + q[1] * f.Y[0] + q[2] * f.Z[0]),
  f.O[1] + f.s * (q[0] * f.X[1] + q[1] * f.Y[1] + q[2] * f.Z[1]),
];

// «Вид» — орієнтири одного кадру (фото або відео) з готовою системою голови.
export function makeView(P3) {
  const f = headFrame(P3);
  return { P: P3, f, fwd: Math.sign(toLocal(P3[1], f)[2]) || 1 };
}

function bary2(p, a, b, c) {
  const v0x = b[0] - a[0], v0y = b[1] - a[1], v1x = c[0] - a[0], v1y = c[1] - a[1];
  const d = v0x * v1y - v1x * v0y;
  if (Math.abs(d) < 1e-9) return null;
  const v2x = p[0] - a[0], v2y = p[1] - a[1];
  const u = (v2x * v1y - v1x * v2y) / d, v = (v0x * v2y - v2x * v0y) / d;
  return [1 - u - v, u, v];
}

// Трикутник сітки, що містить точку; якщо їх кілька (поворот голови) — ближчий до камери.
function meshHit(p, P) {
  let best = null;
  for (let i = 0; i < TRIS.length; i++) {
    const t = TRIS[i], a = P[t[0]], b = P[t[1]], c = P[t[2]];
    if (p[0] < Math.min(a[0], b[0], c[0]) || p[0] > Math.max(a[0], b[0], c[0]) ||
        p[1] < Math.min(a[1], b[1], c[1]) || p[1] > Math.max(a[1], b[1], c[1])) continue;
    const w = bary2(p, a, b, c);
    if (!w || w[0] < -1e-4 || w[1] < -1e-4 || w[2] < -1e-4) continue;
    const z = w[0] * a[2] + w[1] * b[2] + w[2] * c[2];
    if (!best || z < best.z) best = { t: i, w, z };
  }
  return best && { t: best.t, w: best.w };
}

// Зсув q так, щоб проєкція точно потрапила в ціль, не змінюючи глибину вздовж
// напрямку погляду цього кадру (найменша за нормою поправка).
function nudge(q, target, f) {
  const cur = toWorld(q, f);
  const r0 = (target[0] - cur[0]) / f.s, r1 = (target[1] - cur[1]) / f.s;
  return [q[0] + f.X[0] * r0 + f.X[1] * r1, q[1] + f.Y[0] * r0 + f.Y[1] * r1, q[2] + f.Z[0] * r0 + f.Z[1] * r1];
}

// Початкова оцінка для точки поза сіткою: від найближчої точки контуру обличчя,
// з відступом углиб (шия під щелепою відходить назад).
function rigidGuess(p, view) {
  const { P, f, fwd } = view;
  let j = OVAL[0], dj = Infinity;
  OVAL.forEach((i) => { const d = Math.hypot(P[i][0] - p[0], P[i][1] - p[1]); if (d < dj) { dj = d; j = i; } });
  const q = toLocal(P[j], f);
  q[2] -= fwd * 0.5 * (dj / f.s);
  return nudge(q, p, f);
}

// Прив'язка 2D-точки кадру. prev — попередня прив'язка цієї ж точки (щоб під
// час правки зберегти її глибину).
export function anchorAt(p, view, prev = null) {
  const hit = meshHit(p, view.P);
  if (hit) return hit;
  if (prev?.q) return { q: nudge(prev.q, p, view.f) };
  return { q: rigidGuess(p, view) };
}

export function resolveAnchor(a, view) {
  const P = view.P;
  if (a.q) return toWorld(a.q, view.f);
  const t = TRIS[a.t], A = P[t[0]], B = P[t[1]], C = P[t[2]];
  return [a.w[0] * A[0] + a.w[1] * B[0] + a.w[2] * C[0], a.w[0] * A[1] + a.w[1] * B[1] + a.w[2] * C[1]];
}

// Дзеркальна копія точок відносно осі обличчя (для симетричних щік). Працює в
// кадрі анфас: відбиває 2D-точки через вісь «лоб — підборіддя».
export function mirrorPoints(pts, view) {
  const { f } = view;
  return pts.map((p) => {
    const d = [(p[0] - f.O[0]), (p[1] - f.O[1])];
    const k = (d[0] * f.X[0] + d[1] * f.X[1]) / (f.X[0] ** 2 + f.X[1] ** 2);
    return [p[0] - 2 * k * f.X[0], p[1] - 2 * k * f.X[1]];
  });
}

// Фільтр One Euro для всіх орієнтирів: коли голова нерухома — сильне згладжування
// (лінії не тремтять), коли рухається — слабке (лінії не відстають).
export class LandmarkFilter {
  constructor(minCutoff = 0.7, beta = 40, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = null; this.t = 0;
  }
  reset() { this.x = null; }
  apply(P, tMs, scale) {
    const n = P.length * 3;
    if (!this.x) {
      this.x = new Float64Array(n); this.dx = new Float64Array(n);
      for (let i = 0; i < P.length; i++) { this.x[i * 3] = P[i][0]; this.x[i * 3 + 1] = P[i][1]; this.x[i * 3 + 2] = P[i][2]; }
      this.t = tMs;
      return P;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000); this.t = tMs;
    const alpha = (cut) => { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); };
    const ad = alpha(this.dCutoff);
    const out = new Array(P.length);
    for (let i = 0; i < P.length; i++) {
      const o = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const k = i * 3 + c, v = P[i][c];
        const d = (v - this.x[k]) / dt;
        this.dx[k] += (d - this.dx[k]) * ad;
        // швидкість у «ширинах обличчя за секунду», щоб не залежати від роздільності
        const a = alpha(this.minCutoff + this.beta * Math.abs(this.dx[k]) / scale);
        this.x[k] += (v - this.x[k]) * a;
        o[c] = this.x[k];
      }
      out[i] = o;
    }
    return out;
  }
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const add = (a, v, k) => [a[0] + v[0] * k, a[1] + v[1] * k];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function faceFrame2(P) {
  const eyes = lerp(P[33], P[263], 0.5);
  const h = dist(eyes, P[152]);
  const down = [(P[152][0] - eyes[0]) / h, (P[152][1] - eyes[1]) / h];
  return { h, down, up: [-down[0], -down[1]], center: lerp(eyes, P[152], 0.5) };
}

// Типовий контур (запасний варіант): лінія шиї нижче щелепи і дві лінії щік.
export function defaultLines(P) {
  const f = faceFrame2(P);
  const jaw = [361, 397, 365, 378, 152, 149, 136, 172, 132];
  const halfW = dist(P[234], P[454]) / 2;
  const neck = jaw.map((i) => {
    const lateral = Math.min(1, dist(P[i], P[152]) / halfW);
    return add(P[i], f.down, f.h * (0.06 + 0.3 * (1 - lateral) ** 0.7));
  });

  const cheek = (ear, edge, cheekPt, mouth) => {
    const inward = (p) => {
      const v = [f.center[0] - p[0], f.center[1] - p[1]];
      const n = Math.hypot(v[0], v[1]);
      return [v[0] / n, v[1] / n];
    };
    const s0 = lerp(P[ear], P[edge], 0.55);
    const s = add(s0, inward(s0), f.h * 0.06);
    const m1 = add(lerp(P[edge], P[cheekPt], 0.5), f.up, f.h * 0.05);
    const m2 = add(lerp(P[cheekPt], P[mouth], 0.45), f.up, f.h * 0.02);
    const e = lerp(P[mouth], P[cheekPt], 0.3);
    return [s, m1, m2, e];
  };

  return [
    { id: 'neck', name: 'Шия', points: neck },
    { id: 'cheekA', name: 'Щока', points: cheek(127, 234, 205, 61) },
    { id: 'cheekB', name: 'Щока', points: cheek(356, 454, 425, 291) },
  ];
}

// Гладка крива Catmull-Rom через точки.
export function tracePath(ctx, pts) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1],
    );
  }
}

export function distToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
  return { d: dist(p, [a[0] + vx * t, a[1] + vy * t]), t };
}

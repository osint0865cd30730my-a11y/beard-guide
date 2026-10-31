// Геометрія: прив'язка точок контуру до сітки обличчя MediaPipe (478 точок).
// Кожна точка контуру зберігається як афінні (барицентричні) координати відносно
// трикутника з трьох орієнтирів обличчя. У живому режимі точка відновлюється з
// поточних орієнтирів, тож лінія "їде" разом із головою: зсув, поворот, масштаб, нахил.

// Трикутники з індексів орієнтирів, що покривають нижню частину обличчя і шию.
export const TRIS = [
  [234, 1, 61], [454, 1, 291],
  [234, 61, 172], [454, 291, 397],
  [61, 17, 152], [291, 17, 152],
  [61, 152, 172], [291, 152, 397],
  [61, 0, 291], [61, 17, 291],
  [234, 33, 1], [454, 263, 1],
  [172, 152, 397],
  [127, 234, 172], [356, 454, 397],
  [93, 132, 58], [323, 361, 288],
  [127, 33, 234], [356, 263, 454],
];

export function toPx(landmarks, w, h) {
  return landmarks.map((p) => [p.x * w, p.y * h]);
}

function bary(p, a, b, c) {
  const v0x = b[0] - a[0], v0y = b[1] - a[1];
  const v1x = c[0] - a[0], v1y = c[1] - a[1];
  const v2x = p[0] - a[0], v2y = p[1] - a[1];
  const d = v0x * v1y - v1x * v0y;
  if (Math.abs(d) < 1e-6) return null;
  const u = (v2x * v1y - v1x * v2y) / d;
  const v = (v0x * v2y - v2x * v0y) / d;
  return { w: [1 - u - v, u, v], area: Math.abs(d) / 2 };
}

// Обирає трикутник, у якому лежить точка (найменший з тих, що містять її),
// або той, від якого вона виходить найменше.
export function anchorPoint(p, P) {
  let best = null;
  TRIS.forEach((t, i) => {
    const r = bary(p, P[t[0]], P[t[1]], P[t[2]]);
    if (!r) return;
    const out = r.w.reduce((s, x) => s + Math.max(0, -x), 0);
    if (
      !best ||
      out < best.out - 1e-9 ||
      (Math.abs(out - best.out) < 1e-9 && r.area < best.area)
    ) {
      best = { t: i, w: r.w, out, area: r.area };
    }
  });
  return { t: best.t, w: best.w };
}

export function resolvePoint(a, P) {
  const t = TRIS[a.t];
  return [
    a.w[0] * P[t[0]][0] + a.w[1] * P[t[1]][0] + a.w[2] * P[t[2]][0],
    a.w[0] * P[t[0]][1] + a.w[1] * P[t[1]][1] + a.w[2] * P[t[2]][1],
  ];
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const add = (a, v, k) => [a[0] + v[0] * k, a[1] + v[1] * k];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function faceFrame(P) {
  const eyes = lerp(P[33], P[263], 0.5);
  const h = dist(eyes, P[152]);
  const down = [(P[152][0] - eyes[0]) / h, (P[152][1] - eyes[1]) / h];
  return { h, down, up: [-down[0], -down[1]], center: lerp(eyes, P[152], 0.5) };
}

// Типовий контур: лінія шиї (U-подібна, нижче лінії щелепи) і дві лінії щік.
export function defaultLines(P) {
  const f = faceFrame(P);
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

// Сторона обличчя для підпису: точки ліворуч чи праворуч від осі носа.
export function sideOf(pts, P) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  return cx < P[1][0] ? 'L' : 'R';
}

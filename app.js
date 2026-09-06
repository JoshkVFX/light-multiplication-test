// ---------------------------------------------------------------------------
// Light Beam Simulator
// A small ray-tracer: a lamp emits a beam, mirrors reflect it, prisms refract
// it and (on first entry) split white light into a spectrum via wavelength-
// dependent refractive indices (real vector Snell's law).
// ---------------------------------------------------------------------------

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");

// The simulated "room" (wall positions rays bounce inside of) is fixed at
// boot and only follows the actual browser window size -- zooming/panning is
// purely a camera change and must never resize the room itself.
let worldW = window.innerWidth;
let worldH = window.innerHeight;

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  worldW = window.innerWidth;
  worldH = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------------
// Camera (pan/zoom). World coordinates are what every object's x/y is stored
// in; screen coordinates are CSS pixels within the canvas. Zooming in reveals
// beam separation that is too fine to see at 1x by keeping stroke widths a
// constant size on screen while the gaps between beams scale up with zoom.
// ---------------------------------------------------------------------------
const camera = { zoom: 1, panX: 0, panY: 0 };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 40;

function screenToWorld(sx, sy) {
  return { x: (sx - camera.panX) / camera.zoom, y: (sy - camera.panY) / camera.zoom };
}

function zoomAt(sx, sy, factor) {
  const before = screenToWorld(sx, sy);
  camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
  camera.panX = sx - before.x * camera.zoom;
  camera.panY = sy - before.y * camera.zoom;
  updateZoomLabel();
}

function resetView() {
  camera.zoom = 1;
  camera.panX = 0;
  camera.panY = 0;
  updateZoomLabel();
}

function updateZoomLabel() {
  const label = document.getElementById("zoomReset");
  if (label) label.textContent = Math.round(camera.zoom * 100) + "%";
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------
const V = {
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  len: (a) => Math.hypot(a.x, a.y),
  norm: (a) => {
    const l = Math.hypot(a.x, a.y) || 1;
    return { x: a.x / l, y: a.y / l };
  },
  perp: (a) => ({ x: -a.y, y: a.x }),
  fromAngle: (a) => ({ x: Math.cos(a), y: Math.sin(a) }),
  angleOf: (a) => Math.atan2(a.y, a.x),
  reflect: (dir, normal) => {
    const d = V.dot(dir, normal);
    return V.sub(dir, V.scale(normal, 2 * d));
  },
  // Vector Snell's law. normal must be a unit vector; sign is auto-corrected.
  // n1 = index of medium the ray is leaving, n2 = index of medium it enters.
  // Returns null on total internal reflection.
  refract: (dir, normal, n1, n2) => {
    let N = normal;
    let cosI = -V.dot(N, dir);
    if (cosI < 0) {
      N = V.scale(normal, -1);
      cosI = -cosI;
    }
    const eta = n1 / n2;
    const k = 1 - eta * eta * (1 - cosI * cosI);
    if (k < 0) return null;
    const term = eta * cosI - Math.sqrt(k);
    return V.norm(V.add(V.scale(dir, eta), V.scale(N, term)));
  },
};

// Intersect ray (origin o, direction d, both objects {x,y}) with segment p1-p2.
// Returns { t, point, normal } for the closest valid hit (t > EPS), or null.
function raySegmentIntersect(o, d, p1, p2) {
  const v1 = V.sub(o, p1);
  const v2 = V.sub(p2, p1);
  const v3 = { x: -d.y, y: d.x };
  const denom = V.dot(v2, v3);
  if (Math.abs(denom) < 1e-9) return null;
  const t1 = (v2.x * v1.y - v2.y * v1.x) / denom;
  const t2 = V.dot(v1, v3) / denom;
  if (t1 > 1e-6 && t2 >= 0 && t2 <= 1) {
    const point = { x: o.x + d.x * t1, y: o.y + d.y * t1 };
    let normal = V.norm(V.perp(v2));
    return { t: t1, point, normal };
  }
  return null;
}

// Positive ray-circle intersection distances, nearest first (a is 1 since d is unit length).
function rayCircleHits(o, d, center, R) {
  const oc = V.sub(o, center);
  const b = 2 * V.dot(oc, d);
  const c = V.dot(oc, oc) - R * R;
  const disc = b * b - 4 * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-b - sq) / 2, (-b + sq) / 2].filter((t) => t > 1e-6).sort((a, b) => a - b);
}

// Rotate/translate helpers for objects with their own (x, y, angle) frame.
function toLocal(obj, p) {
  const dx = p.x - obj.x;
  const dy = p.y - obj.y;
  const c = Math.cos(-obj.angle);
  const s = Math.sin(-obj.angle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
function toWorld(obj, p) {
  const c = Math.cos(obj.angle);
  const s = Math.sin(obj.angle);
  return { x: obj.x + p.x * c - p.y * s, y: obj.y + p.x * s + p.y * c };
}

function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Spectrum: dispersion is modelled with a distinct refractive index per band,
// red bending least and violet bending most, as in a real glass prism.
// ---------------------------------------------------------------------------
const SPECTRUM = [
  { hex: "#ff3b30", ior: 1.505 },
  { hex: "#ff9500", ior: 1.512 },
  { hex: "#ffe600", ior: 1.519 },
  { hex: "#3ddc55", ior: 1.526 },
  { hex: "#34aeff", ior: 1.533 },
  { hex: "#5865f2", ior: 1.540 },
  { hex: "#b34cff", ior: 1.548 },
];
const DEFAULT_IOR = 1.52;
const WHITE = "white";
// Lenses use a single fixed index for every colour (no chromatic aberration),
// so a beam that a prism has split back into a spectrum can be refocused to
// one point instead of drifting apart further.
const LENS_IOR = 1.5;

// ---------------------------------------------------------------------------
// Scene objects
// ---------------------------------------------------------------------------
let idSeq = 1;

class Lamp {
  constructor(x, y, angle) {
    this.id = idSeq++;
    this.type = "lamp";
    this.x = x;
    this.y = y;
    this.angle = angle;
  }
  handlePos() {
    return V.add({ x: this.x, y: this.y }, V.scale(V.fromAngle(this.angle), 46));
  }
  hitBody(p) {
    return Math.hypot(p.x - this.x, p.y - this.y) < 20;
  }
  hitHandle(p) {
    const h = this.handlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 10;
  }
}

class Mirror {
  constructor(x, y, angle, length = 160) {
    this.id = idSeq++;
    this.type = "mirror";
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.length = length;
  }
  endpoints() {
    const half = V.scale(V.fromAngle(this.angle), this.length / 2);
    return [V.sub({ x: this.x, y: this.y }, half), V.add({ x: this.x, y: this.y }, half)];
  }
  segments() {
    const [p1, p2] = this.endpoints();
    return [{ p1, p2, kind: "mirror" }];
  }
  handlePos() {
    const [, p2] = this.endpoints();
    return V.add(p2, V.scale(V.fromAngle(this.angle), 22));
  }
  resizeHandlePos() {
    const [, p2] = this.endpoints();
    return p2;
  }
  hitBody(p) {
    const [p1, p2] = this.endpoints();
    return distToSegment(p, p1, p2) < 10;
  }
  hitHandle(p) {
    const h = this.handlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 9;
  }
  hitResizeHandle(p) {
    const h = this.resizeHandlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 8;
  }
  resize(mouse) {
    this.length = Math.max(30, 2 * Math.hypot(mouse.x - this.x, mouse.y - this.y));
  }
}

class Prism {
  constructor(x, y, angle, size = 70) {
    this.id = idSeq++;
    this.type = "prism";
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.size = size;
  }
  vertices() {
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const a = this.angle + (i * 2 * Math.PI) / 3 - Math.PI / 2;
      pts.push(V.add({ x: this.x, y: this.y }, V.scale(V.fromAngle(a), this.size)));
    }
    return pts;
  }
  segments() {
    const v = this.vertices();
    const center = { x: this.x, y: this.y };
    const segs = [];
    for (let i = 0; i < 3; i++) {
      const p1 = v[i];
      const p2 = v[(i + 1) % 3];
      segs.push({ p1, p2, kind: "prism", owner: this, center });
    }
    return segs;
  }
  handlePos() {
    const v = this.vertices();
    return V.add(v[0], V.scale(V.norm(V.sub(v[0], { x: this.x, y: this.y })), 18));
  }
  resizeHandlePos() {
    return this.vertices()[0];
  }
  hitBody(p) {
    return pointInTriangle(p, ...this.vertices());
  }
  hitHandle(p) {
    const h = this.handlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 9;
  }
  hitResizeHandle(p) {
    const h = this.resizeHandlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 8;
  }
  resize(mouse) {
    this.size = Math.max(24, Math.hypot(mouse.x - this.x, mouse.y - this.y));
  }
}

class Blocker {
  constructor(x, y, angle, length = 110) {
    this.id = idSeq++;
    this.type = "blocker";
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.length = length;
  }
  endpoints() {
    const half = V.scale(V.fromAngle(this.angle), this.length / 2);
    return [V.sub({ x: this.x, y: this.y }, half), V.add({ x: this.x, y: this.y }, half)];
  }
  segments() {
    const [p1, p2] = this.endpoints();
    return [{ p1, p2, kind: "blocker" }];
  }
  handlePos() {
    const [, p2] = this.endpoints();
    return V.add(p2, V.scale(V.fromAngle(this.angle), 22));
  }
  resizeHandlePos() {
    const [, p2] = this.endpoints();
    return p2;
  }
  hitBody(p) {
    const [p1, p2] = this.endpoints();
    return distToSegment(p, p1, p2) < 10;
  }
  hitHandle(p) {
    const h = this.handlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 9;
  }
  hitResizeHandle(p) {
    const h = this.resizeHandlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 8;
  }
  resize(mouse) {
    this.length = Math.max(30, 2 * Math.hypot(mouse.x - this.x, mouse.y - this.y));
  }
}

// A converging lens: two circular-arc glass surfaces (a biconvex lens shape).
// Uses a single fixed refractive index for every ray, regardless of colour,
// so a spectrum spread out by a prism can be bent back to a single point.
class Lens {
  constructor(x, y, angle, size = 55) {
    this.id = idSeq++;
    this.type = "lens";
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.size = size; // half-aperture (height) of the lens
  }
  get h() {
    return this.size;
  }
  get R() {
    return this.size * 2.2; // curvature radius; >size keeps the surfaces valid
  }
  get d() {
    const R = this.R;
    const h = Math.min(this.h, R - 1);
    return Math.sqrt(R * R - h * h);
  }
  // Outline of the lens body in its own local (unrotated, centered) frame.
  localOutline(N = 16) {
    const h = Math.min(this.h, this.R - 1);
    const theta = Math.asin(h / this.R);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const phi = Math.PI - theta + (2 * theta * i) / N;
      pts.push({ x: this.d + this.R * Math.cos(phi), y: this.R * Math.sin(phi) });
    }
    for (let i = 0; i <= N; i++) {
      const phi = -theta + (2 * theta * i) / N;
      pts.push({ x: -this.d + this.R * Math.cos(phi), y: this.R * Math.sin(phi) });
    }
    return pts;
  }
  segments() {
    const h = Math.min(this.h, this.R - 1);
    return [
      { kind: "lens", owner: this, side: "left", R: this.R, halfHeight: h, center: toWorld(this, { x: this.d, y: 0 }) },
      { kind: "lens", owner: this, side: "right", R: this.R, halfHeight: h, center: toWorld(this, { x: -this.d, y: 0 }) },
    ];
  }
  handlePos() {
    return toWorld(this, { x: 0, y: -(this.h + 22) });
  }
  resizeHandlePos() {
    return toWorld(this, { x: 0, y: -this.h });
  }
  hitBody(p) {
    return pointInPolygon(toLocal(this, p), this.localOutline(10));
  }
  hitHandle(p) {
    const h = this.handlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 9;
  }
  hitResizeHandle(p) {
    const h = this.resizeHandlePos();
    return Math.hypot(p.x - h.x, p.y - h.y) < 8;
  }
  resize(mouse) {
    this.size = Math.max(20, Math.hypot(mouse.x - this.x, mouse.y - this.y));
  }
}

function distToSegment(p, a, b) {
  const ab = V.sub(b, a);
  const t = Math.max(0, Math.min(1, V.dot(V.sub(p, a), ab) / (V.dot(ab, ab) || 1)));
  const proj = V.add(a, V.scale(ab, t));
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

function pointInTriangle(p, a, b, c) {
  const s = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  const t = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const d = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const hasNeg = s < 0 || t < 0 || d < 0;
  const hasPos = s > 0 || t > 0 || d > 0;
  return !(hasNeg && hasPos);
}

// ---------------------------------------------------------------------------
// Scene state
// ---------------------------------------------------------------------------
const lamp = new Lamp(140, 140, 0.5);
const objects = [];

function placeDefault(Ctor, extraAngle = 0) {
  // Drop the new object near the center of whatever is currently on screen,
  // not the window center, so it still lands in view after panning/zooming.
  const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const jitter = 1 / camera.zoom;
  const cx = center.x + (Math.random() - 0.5) * 200 * jitter;
  const cy = center.y + (Math.random() - 0.5) * 150 * jitter;
  return new Ctor(cx, cy, Math.random() * Math.PI + extraAngle);
}

document.getElementById("addMirror").onclick = () => {
  objects.push(placeDefault(Mirror));
};
document.getElementById("addPrism").onclick = () => {
  objects.push(placeDefault(Prism));
};
document.getElementById("addBlocker").onclick = () => {
  objects.push(placeDefault(Blocker));
};
document.getElementById("addLens").onclick = () => {
  objects.push(placeDefault(Lens));
};
document.getElementById("clearAll").onclick = () => {
  objects.length = 0;
  selected = null;
};
document.getElementById("zoomIn").onclick = () => {
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.4);
};
document.getElementById("zoomOut").onclick = () => {
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.4);
};
document.getElementById("zoomReset").onclick = resetView;

// ---------------------------------------------------------------------------
// Ray tracing
// ---------------------------------------------------------------------------
const MAX_BOUNCES = 60;
const MAX_RAYS = 400;
const EPS_PUSH = 0.05;

// Dispatches to a straight-edge or curved-lens intersection test depending
// on the surface's kind, returning { t, point, normal } or null.
function intersectSurface(o, d, seg) {
  if (seg.kind === "lens") {
    const hits = rayCircleHits(o, d, seg.center, seg.R);
    for (const t of hits) {
      const point = V.add(o, V.scale(d, t));
      const local = toLocal(seg.owner, point);
      const onThisSide = seg.side === "left" ? local.x <= 0.5 : local.x >= -0.5;
      if (Math.abs(local.y) <= seg.halfHeight + 0.001 && onThisSide) {
        const normal = V.norm(V.sub(point, seg.center));
        return { t, point, normal };
      }
    }
    return null;
  }
  return raySegmentIntersect(o, d, seg.p1, seg.p2);
}

function traceScene(w, h) {
  const boundary = [
    { p1: { x: 0, y: 0 }, p2: { x: w, y: 0 }, kind: "wall" },
    { p1: { x: w, y: 0 }, p2: { x: w, y: h }, kind: "wall" },
    { p1: { x: w, y: h }, p2: { x: 0, y: h }, kind: "wall" },
    { p1: { x: 0, y: h }, p2: { x: 0, y: 0 }, kind: "wall" },
  ];

  const allSegments = [...boundary];
  for (const obj of objects) allSegments.push(...obj.segments());

  const drawSegments = [];
  let rays = [
    {
      o: { x: lamp.x, y: lamp.y },
      d: V.fromAngle(lamp.angle),
      color: WHITE,
      ior: 1,
      bounces: 0,
    },
  ];

  let guard = 0;
  while (rays.length && guard < MAX_RAYS) {
    const ray = rays.pop();
    guard++;
    let closest = null;
    for (const seg of allSegments) {
      const hit = intersectSurface(ray.o, ray.d, seg);
      if (hit && (!closest || hit.t < closest.t)) {
        closest = { ...hit, seg };
      }
    }
    if (!closest) continue;

    drawSegments.push({
      x1: ray.o.x,
      y1: ray.o.y,
      x2: closest.point.x,
      y2: closest.point.y,
      color: ray.color,
    });

    if (closest.seg.kind === "wall" || closest.seg.kind === "blocker") continue;
    if (ray.bounces >= MAX_BOUNCES) continue;

    if (closest.seg.kind === "mirror") {
      let n = closest.normal;
      if (V.dot(n, ray.d) > 0) n = V.scale(n, -1);
      const newDir = V.reflect(ray.d, n);
      rays.push({
        o: V.add(closest.point, V.scale(newDir, EPS_PUSH)),
        d: newDir,
        color: ray.color,
        ior: ray.ior,
        bounces: ray.bounces + 1,
      });
      continue;
    }

    if (closest.seg.kind === "lens") {
      // Achromatic: every ray bends the same way regardless of colour, so a
      // dispersed spectrum can be brought back together at one focus.
      const n = closest.normal;
      const entering = V.dot(n, ray.d) < 0;
      const n1 = entering ? 1 : LENS_IOR;
      const n2 = entering ? LENS_IOR : 1;
      let dir = V.refract(ray.d, n, n1, n2);
      if (!dir) {
        let rn = n;
        if (V.dot(rn, ray.d) > 0) rn = V.scale(rn, -1);
        dir = V.reflect(ray.d, rn);
      }
      rays.push({
        o: V.add(closest.point, V.scale(dir, EPS_PUSH)),
        d: dir,
        color: ray.color,
        ior: ray.ior,
        bounces: ray.bounces + 1,
      });
      continue;
    }

    if (closest.seg.kind === "prism") {
      // Outward normal: point away from the prism's centroid.
      let n = closest.normal;
      const toOutside = V.sub(closest.point, closest.seg.center);
      if (V.dot(n, toOutside) < 0) n = V.scale(n, -1);
      const entering = V.dot(n, ray.d) < 0;

      if (ray.color === WHITE) {
        // First contact with glass: split into the spectrum.
        for (const band of SPECTRUM) {
          const n1 = entering ? 1 : band.ior;
          const n2 = entering ? band.ior : 1;
          let dir = V.refract(ray.d, n, n1, n2);
          if (!dir) {
            let rn = n;
            if (V.dot(rn, ray.d) > 0) rn = V.scale(rn, -1);
            dir = V.reflect(ray.d, rn);
          }
          rays.push({
            o: V.add(closest.point, V.scale(dir, EPS_PUSH)),
            d: dir,
            color: band.hex,
            ior: band.ior,
            bounces: ray.bounces + 1,
          });
        }
      } else {
        const rayIor = ray.ior || DEFAULT_IOR;
        const n1 = entering ? 1 : rayIor;
        const n2 = entering ? rayIor : 1;
        let dir = V.refract(ray.d, n, n1, n2);
        if (!dir) {
          let rn = n;
          if (V.dot(rn, ray.d) > 0) rn = V.scale(rn, -1);
          dir = V.reflect(ray.d, rn);
        }
        rays.push({
          o: V.add(closest.point, V.scale(dir, EPS_PUSH)),
          d: dir,
          color: ray.color,
          ior: rayIor,
          bounces: ray.bounces + 1,
        });
      }
    }
  }
  return drawSegments;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function draw() {
  // Clear and paint the background in raw device pixels, before the camera
  // transform is applied, so it always covers the full canvas regardless of
  // pan/zoom.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0a0e17";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Everything else is drawn in world coordinates; this transform maps world
  // space to screen space (CSS px) and then to device pixels.
  ctx.setTransform(
    devicePixelRatio * camera.zoom,
    0,
    0,
    devicePixelRatio * camera.zoom,
    devicePixelRatio * camera.panX,
    devicePixelRatio * camera.panY
  );

  const segments = traceScene(worldW, worldH);

  // Beam strokes/glow are sized in *screen* pixels (divided by zoom here so
  // that the world-space lineWidth, once scaled back up by the transform,
  // comes out constant) so zooming in reveals real gaps between beams that
  // are too fine to see at 1x, instead of every beam just getting thicker.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const s of segments) {
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.strokeStyle = s.color === WHITE ? "#ffffff" : s.color;
    ctx.lineWidth = (s.color === WHITE ? 2.6 : 2.2) / camera.zoom;
    ctx.shadowColor = s.color === WHITE ? "#ffffff" : s.color;
    ctx.shadowBlur = 14 / camera.zoom;
    ctx.stroke();
  }
  ctx.restore();
  ctx.shadowBlur = 0;

  for (const obj of objects) drawObject(obj);
  drawLamp();
}

function drawLamp() {
  const glowGrad = ctx.createRadialGradient(lamp.x, lamp.y, 2, lamp.x, lamp.y, 34);
  glowGrad.addColorStop(0, "rgba(255,255,255,0.9)");
  glowGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(lamp.x, lamp.y, 34, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(lamp.x, lamp.y, 14, 0, Math.PI * 2);
  ctx.fillStyle = "#f4f7ff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = selected === lamp ? "#4fa8ff" : "#8b96b3";
  ctx.stroke();

  const handle = lamp.handlePos();
  ctx.beginPath();
  ctx.moveTo(lamp.x, lamp.y);
  ctx.lineTo(handle.x, handle.y);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(handle.x, handle.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#0a0e17";
  ctx.fill();
  ctx.strokeStyle = "#4fa8ff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawObject(obj) {
  const isSel = obj === selected;
  if (obj.type === "mirror") {
    const [p1, p2] = obj.endpoints();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = isSel ? "#4fa8ff" : "#c9d3e8";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(150,190,255,0.6)";
    ctx.shadowBlur = isSel ? 12 : 4;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // hatching on the back side to suggest a reflective coating
    const dir = V.norm(V.sub(p2, p1));
    const n = V.perp(dir);
    const back = V.scale(n, 6);
    const steps = Math.max(2, Math.floor(obj.length / 14));
    ctx.strokeStyle = "rgba(120,140,180,0.6)";
    ctx.lineWidth = 1.5;
    for (let i = 1; i < steps; i++) {
      const p = V.add(p1, V.scale(V.sub(p2, p1), i / steps));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + back.x, p.y + back.y);
      ctx.stroke();
    }
  } else if (obj.type === "prism") {
    const v = obj.vertices();
    ctx.beginPath();
    ctx.moveTo(v[0].x, v[0].y);
    ctx.lineTo(v[1].x, v[1].y);
    ctx.lineTo(v[2].x, v[2].y);
    ctx.closePath();
    const grad = ctx.createLinearGradient(v[0].x, v[0].y, v[2].x, v[2].y);
    grad.addColorStop(0, "rgba(150,210,255,0.16)");
    grad.addColorStop(1, "rgba(200,160,255,0.16)");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = isSel ? "#4fa8ff" : "rgba(220,230,250,0.85)";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(160,200,255,0.5)";
    ctx.shadowBlur = isSel ? 10 : 3;
    ctx.stroke();
    ctx.shadowBlur = 0;
  } else if (obj.type === "blocker") {
    const [p1, p2] = obj.endpoints();
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = isSel ? "#4fa8ff" : "#3a4356";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.stroke();
  } else if (obj.type === "lens") {
    const pts = obj.localOutline();
    ctx.save();
    ctx.translate(obj.x, obj.y);
    ctx.rotate(obj.angle);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const pt of pts.slice(1)) ctx.lineTo(pt.x, pt.y);
    ctx.closePath();
    const grad = ctx.createLinearGradient(-obj.h, 0, obj.h, 0);
    grad.addColorStop(0, "rgba(180,225,255,0.22)");
    grad.addColorStop(0.5, "rgba(220,240,255,0.32)");
    grad.addColorStop(1, "rgba(180,225,255,0.22)");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = isSel ? "#4fa8ff" : "rgba(220,235,255,0.9)";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(170,210,255,0.6)";
    ctx.shadowBlur = isSel ? 10 : 3;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // rotate handle (ring)
  if (obj.handlePos) {
    const h = obj.handlePos();
    const c = { x: obj.x, y: obj.y };
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(h.x, h.y);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? "#4fa8ff" : "rgba(180,190,210,0.5)";
    ctx.fill();
  }

  // resize handle (square)
  if (obj.resizeHandlePos) {
    const r = obj.resizeHandlePos();
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(obj.angle);
    ctx.fillStyle = isSel ? "#ffb84f" : "rgba(210,190,150,0.6)";
    ctx.fillRect(-5, -5, 10, 10);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
let selected = null;
let drag = null; // { kind: 'move'|'rotate'|'resize'|'pan', target, offset }
let spaceDown = false;

// Screen coordinates: CSS pixels within the canvas element.
function screenPos(evt) {
  const r = canvas.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}
// World coordinates: what every object's x/y is stored in, independent of
// the current pan/zoom.
function worldPos(evt) {
  const s = screenPos(evt);
  return screenToWorld(s.x, s.y);
}

window.addEventListener("keydown", (evt) => {
  if (evt.code === "Space" && !spaceDown) {
    spaceDown = true;
    if (!drag) canvas.style.cursor = "grab";
    evt.preventDefault();
  }
});
window.addEventListener("keyup", (evt) => {
  if (evt.code === "Space") {
    spaceDown = false;
    if (!drag) canvas.style.cursor = "";
  }
});

canvas.addEventListener(
  "wheel",
  (evt) => {
    evt.preventDefault();
    const s = screenPos(evt);
    if (evt.ctrlKey) {
      // Trackpad pinch gestures are reported as wheel events with ctrlKey
      // set; plain ctrl+wheel zooms too, for mouse users.
      zoomAt(s.x, s.y, Math.exp(-evt.deltaY * 0.015));
    } else {
      camera.panX -= evt.deltaX;
      camera.panY -= evt.deltaY;
    }
  },
  { passive: false }
);

canvas.addEventListener("pointerdown", (evt) => {
  canvas.setPointerCapture(evt.pointerId);

  if (evt.button === 1 || spaceDown) {
    evt.preventDefault();
    const s = screenPos(evt);
    drag = { kind: "pan", startScreen: s, startPan: { x: camera.panX, y: camera.panY } };
    canvas.style.cursor = "grabbing";
    return;
  }

  const p = worldPos(evt);

  // lamp handle / body first (topmost priority for aiming)
  if (lamp.hitHandle(p)) {
    drag = { kind: "rotate", target: lamp };
    selected = lamp;
    return;
  }
  if (lamp.hitBody(p)) {
    drag = { kind: "move", target: lamp, offset: { x: p.x - lamp.x, y: p.y - lamp.y } };
    selected = lamp;
    return;
  }

  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.hitResizeHandle && obj.hitResizeHandle(p)) {
      drag = { kind: "resize", target: obj };
      selected = obj;
      return;
    }
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.hitHandle(p)) {
      drag = { kind: "rotate", target: obj };
      selected = obj;
      return;
    }
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (obj.hitBody(p)) {
      drag = { kind: "move", target: obj, offset: { x: p.x - obj.x, y: p.y - obj.y } };
      selected = obj;
      return;
    }
  }
  selected = null;
});

canvas.addEventListener("pointermove", (evt) => {
  if (!drag) return;
  if (drag.kind === "pan") {
    const s = screenPos(evt);
    camera.panX = drag.startPan.x + (s.x - drag.startScreen.x);
    camera.panY = drag.startPan.y + (s.y - drag.startScreen.y);
    return;
  }
  const p = worldPos(evt);
  const t = drag.target;
  if (drag.kind === "move") {
    t.x = p.x - drag.offset.x;
    t.y = p.y - drag.offset.y;
  } else if (drag.kind === "rotate") {
    t.angle = Math.atan2(p.y - t.y, p.x - t.x);
  } else if (drag.kind === "resize") {
    t.resize(p);
  }
});

window.addEventListener("pointerup", () => {
  if (drag && drag.kind === "pan") canvas.style.cursor = spaceDown ? "grab" : "";
  drag = null;
});

window.addEventListener("keydown", (evt) => {
  if ((evt.key === "Delete" || evt.key === "Backspace") && selected && selected !== lamp) {
    const idx = objects.indexOf(selected);
    if (idx >= 0) objects.splice(idx, 1);
    selected = null;
  } else if (evt.key === "+" || evt.key === "=") {
    zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25);
  } else if (evt.key === "-" || evt.key === "_") {
    zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.25);
  } else if (evt.key === "0") {
    resetView();
  }
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
function loop() {
  draw();
  requestAnimationFrame(loop);
}

// Seed the scene with one of each so the idea is obvious on first load.
// Positions are fixed offsets from the lamp (not window percentages) so the
// beam-to-prism geometry -- and therefore the clean dispersion fan -- looks
// the same regardless of the window's aspect ratio.
function seedScene() {
  const w = window.innerWidth || document.documentElement.clientWidth;
  const h = window.innerHeight || document.documentElement.clientHeight;

  lamp.x = Math.min(150, w * 0.15);
  lamp.y = Math.min(150, h * 0.2);
  lamp.angle = 0.6;

  const beamDir = V.fromAngle(lamp.angle);
  const prismPos = V.add({ x: lamp.x, y: lamp.y }, V.scale(beamDir, 380));
  objects.push(new Prism(prismPos.x, prismPos.y, 0.79));

  objects.push(new Mirror(Math.max(w * 0.78, lamp.x + 560), Math.max(h * 0.22, lamp.y - 20), Math.PI * 0.62));
}
function boot() {
  const w = window.innerWidth || document.documentElement.clientWidth;
  const h = window.innerHeight || document.documentElement.clientHeight;
  if (!w || !h) {
    setTimeout(boot, 30);
    return;
  }
  resize();
  seedScene();
  updateZoomLabel();
  loop();
}
boot();

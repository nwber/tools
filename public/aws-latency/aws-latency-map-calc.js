/**
 * Pure math for the /aws-latency/ map (unit-tested with vitest): the
 * equirectangular world projection, view fitting/clamping/zooming, the
 * TopoJSON decoder for the country outline, great-circle interpolation
 * for the user->region lines, antimeridian wrapping, and the latency
 * color scale. The DOM wiring that calls all of this lives in
 * aws-latency-map.js.
 *
 * The world is a fixed 3600x1800-unit box (10 units per degree, x from
 * lon -180..180, y from lat 90..-90). A view is {cx, cy, k}: the world
 * point at the viewport center and the scale in px per world unit, so
 * every pan/zoom/fit is plain arithmetic on those three numbers.
 */

/** World size in map units (10 units per degree). */
export const WORLD_W = 3600;
export const WORLD_H = 1800;

/** Equirectangular projection: longitude/latitude in degrees -> world units. */
export const worldX = (lon) => (lon + 180) * 10;
export const worldY = (lat) => (90 - lat) * 10;

/**
 * World point under view -> viewport px. Inverse of the render transform
 * translate(w/2, h/2) scale(k) translate(-cx, -cy).
 */
export function screenPoint(view, viewport, x, y) {
  return [
    (x - view.cx) * view.k + viewport.w / 2,
    (y - view.cy) * view.k + viewport.h / 2,
  ];
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/** Bounds box {minX, maxX, minY, maxY} of world-unit points. */
export function boundsOf(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Center + scale that fits a bounds box into the viewport with `pad` px
 * around it, clamped to [minK, maxK]. Degenerate spans (a single point)
 * are treated as 1e-9 wide, so fitting one point zooms to maxK.
 */
export function fitView(bounds, viewport, { pad = 40, minK = 0, maxK = Infinity } = {}) {
  const spanX = Math.max(1e-9, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-9, bounds.maxY - bounds.minY);
  const usableW = Math.max(1, viewport.w - 2 * pad);
  const usableH = Math.max(1, viewport.h - 2 * pad);
  const k = clamp(Math.min(usableW / spanX, usableH / spanY), minK, maxK);
  return { cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, k };
}

/**
 * Confine a view to the world box: panning stops at the edges, and a
 * view already wider/taller than the world is locked to its center (the
 * whole world is visible, so there is nothing to pan to).
 */
export function clampView(view, viewport, world = { w: WORLD_W, h: WORLD_H }) {
  const halfW = viewport.w / (2 * view.k);
  const halfH = viewport.h / (2 * view.k);
  const cx = 2 * halfW >= world.w ? world.w / 2 : clamp(view.cx, halfW, world.w - halfW);
  const cy = 2 * halfH >= world.h ? world.h / 2 : clamp(view.cy, halfH, world.h - halfH);
  return { cx, cy, k: view.k };
}

/**
 * Zoom by `factor` about the viewport point (px, py), clamped to
 * [minK, maxK]: the world point under that cursor stays under it.
 */
export function zoomAt(view, viewport, px, py, factor, { minK = 0, maxK = Infinity } = {}) {
  const k = clamp(view.k * factor, minK, maxK);
  if (k === view.k) return { ...view };
  const dx = (px - viewport.w / 2) / view.k - (px - viewport.w / 2) / k;
  const dy = (py - viewport.h / 2) / view.k - (py - viewport.h / 2) / k;
  return { cx: view.cx + dx, cy: view.cy + dy, k };
}

/**
 * Scale limits for a viewport: kMin shows the whole world with a hair of
 * margin; kMax (16 px/unit, ~0.7 km/px) is the closest useful zoom.
 */
export function scaleLimits(viewport) {
  return {
    kMin: Math.min(viewport.w / WORLD_W, viewport.h / WORLD_H) * 0.95,
    kMax: 16,
  };
}

/**
 * The value within 180° of `ref` that equals `lon` modulo 360 (ties go
 * east). Computed as an integer-multiple-of-360 shift, so the common
 * no-shift case returns `lon` unchanged instead of reintroducing
 * floating-point noise at the line endpoints.
 */
export function unwrapNear(lon, ref) {
  return lon + Math.round((ref - lon) / 360) * 360;
}

const DEG = Math.PI / 180;

const toVector = ({ lat, lon }) => {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  return [
    Math.cos(phi) * Math.cos(lambda),
    Math.cos(phi) * Math.sin(lambda),
    Math.sin(phi),
  ];
};

const toLatLon = ([x, y, z]) => ({
  lat: Math.atan2(z, Math.hypot(x, y)) / DEG,
  lon: Math.atan2(y, x) / DEG,
});

/**
 * Points along the shorter great-circle arc from `from` to `to`, as
 * {lat, lon} objects with continuous longitudes: the target longitude is
 * unwrapped to within 180° of the start's, and every interpolated point
 * is re-anchored the same way, so the arc never jumps 360° at the
 * antimeridian (the shorter arc spans less than 180° of longitude).
 *
 * Nearly antipodal endpoints (sin(omega) ~ 0) have no unique great
 * circle; those fall back to flat lat/lon interpolation.
 */
export function greatCirclePoints(from, to, maxPoints = 64) {
  const targetLon = unwrapNear(to.lon, from.lon);
  if (from.lat === to.lat && targetLon === from.lon) {
    return [{ ...from }, { lat: to.lat, lon: targetLon }];
  }
  const a = toVector(from);
  const b = toVector({ lat: to.lat, lon: targetLon });
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);

  if (sinOmega < 1e-6) {
    const n = Math.max(2, Math.min(maxPoints - 1, 32));
    const points = [];
    for (let i = 0; i <= n; i += 1) {
      const t = i / n;
      points.push({
        lat: from.lat + (to.lat - from.lat) * t,
        lon: from.lon + (targetLon - from.lon) * t,
      });
    }
    return points;
  }

  // One point per ~2° of arc, capped, so short hops stay light and
  // transcontinental arcs stay smooth.
  const n = clamp(Math.round(omega / DEG / 2) + 2, 2, maxPoints - 1);
  const points = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const wa = Math.sin((1 - t) * omega) / sinOmega;
    const wb = Math.sin(t * omega) / sinOmega;
    const p = toLatLon([
      a[0] * wa + b[0] * wb,
      a[1] * wa + b[1] * wb,
      a[2] * wa + b[2] * wb,
    ]);
    points.push({ lat: p.lat, lon: unwrapNear(p.lon, from.lon) });
  }
  // Exact endpoints, so the line starts and ends on the markers.
  points[0] = { ...from };
  points[n] = { lat: to.lat, lon: targetLon };
  return points;
}

/**
 * Longitude shifts at which a polyline should also be drawn so the part
 * that runs off the flat map at one edge re-enters at the other: always
 * 0, plus +360 when the path dips below -180 or -360 when it exceeds
 * +180 (the view is confined to the world box, so one shifted copy is
 * always enough for a <=180° arc).
 */
export function wrapShifts(points) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.lon < min) min = point.lon;
    if (point.lon > max) max = point.lon;
  }
  const shifts = [0];
  if (min < -180) shifts.push(360);
  if (max > 180) shifts.push(-360);
  return shifts;
}

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * Decode world-atlas TopoJSON (quantized, delta-encoded arcs) into one
 * SVG path string per country, in world units: negative arc indices are
 * the same arcs reversed, consecutive arcs share an endpoint that is
 * emitted once, and every ring closes with Z (holes in country polygons
 * resolve through the caller's fill-rule="evenodd").
 */
export function topologyPaths(topology) {
  const { scale, translate } = topology.transform;
  const arcs = topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [translate[0] + scale[0] * x, translate[1] + scale[1] * y];
    });
  });
  const arcPoints = (index) => (index >= 0 ? arcs[index] : [...arcs[~index]].reverse());

  const ringPath = (ring) => {
    const pts = [];
    for (const index of ring) {
      const points = arcPoints(index);
      for (let i = 0; i < points.length; i += 1) {
        const [lon, lat] = points[i];
        // Each arc starts where the previous one ended; emit the shared
        // point once (a malformed arc that does not chain loses nothing).
        if (i === 0 && pts.length > 0) {
          const [prevLon, prevLat] = pts[pts.length - 1];
          if (lon === prevLon && lat === prevLat) continue;
        }
        pts.push([lon, lat]);
      }
    }
    // Rings are closed; Z draws the closing leg, so drop a final point
    // that repeats the first.
    if (pts.length > 1) {
      const [lon, lat] = pts[pts.length - 1];
      const [firstLon, firstLat] = pts[0];
      if (lon === firstLon && lat === firstLat) pts.pop();
    }
    if (pts.length === 0) return "";
    let d = "";
    for (let i = 0; i < pts.length; i += 1) {
      d += (i === 0 ? "M" : "L") + round1(worldX(pts[i][0])) + " " + round1(worldY(pts[i][1]));
    }
    return d + "Z";
  };

  const paths = [];
  for (const geometry of topology.objects.countries.geometries) {
    const rings = geometry.type === "Polygon" ? geometry.arcs : geometry.arcs.flat();
    let d = "";
    for (const ring of rings) d += ringPath(ring);
    if (d !== "") paths.push(d);
  }
  return paths;
}

/**
 * Line style for a measured median across the run's slowest median:
 * green and thin when fast, red and thick when slow. The caller styles
 * unmeasured lines gray instead of calling this.
 */
export function latencyStyle(median, maxMedian) {
  const t = maxMedian > 0 ? clamp(median / maxMedian, 0, 1) : 0;
  return {
    color: `hsl(${Math.round(145 * (1 - t))}, 75%, ${Math.round(38 + 8 * t)}%)`,
    width: 1.5 + 2.5 * t,
  };
}

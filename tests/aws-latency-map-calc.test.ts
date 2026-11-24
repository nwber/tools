/**
 * Tests for the /aws-latency/ map math (public/aws-latency/
 * aws-latency-map-calc.js) and the generated world outline dataset.
 */

import { describe, expect, it } from "vitest";

import outline from "../public/data/world-outline.json";
import {
  WORLD_H,
  WORLD_W,
  boundsOf,
  clampView,
  fitView,
  greatCirclePoints,
  latencyStyle,
  scaleLimits,
  screenPoint,
  topologyPaths,
  unwrapNear,
  wrapShifts,
  worldX,
  worldY,
  zoomAt,
} from "../public/aws-latency/aws-latency-map-calc.js";

describe("projection", () => {
  it("maps lon -180..180 to x 0..3600 and lat 90..-90 to y 0..1800", () => {
    expect(worldX(-180)).toBe(0);
    expect(worldX(0)).toBe(1800);
    expect(worldX(180)).toBe(3600);
    expect(worldY(90)).toBe(0);
    expect(worldY(0)).toBe(900);
    expect(worldY(-90)).toBe(1800);
    expect(WORLD_W).toBe(3600);
    expect(WORLD_H).toBe(1800);
  });

  it("projects a view point to viewport px, centered on (cx, cy)", () => {
    const view = { cx: 1800, cy: 900, k: 1 };
    const viewport = { w: 800, h: 400 };
    expect(screenPoint(view, viewport, 1800, 900)).toEqual([400, 200]);
    expect(screenPoint(view, viewport, 1900, 900)).toEqual([500, 200]);
    expect(screenPoint({ ...view, k: 2 }, viewport, 1900, 900)).toEqual([600, 200]);
  });

  it("computes bounds boxes", () => {
    expect(boundsOf([[0, 0], [10, 5], [3, 7]])).toEqual({ minX: 0, maxX: 10, minY: 0, maxY: 7 });
  });
});

describe("fitView", () => {
  const viewport = { w: 800, h: 400 };

  it("fits the tighter axis and centers the box", () => {
    const view = fitView({ minX: 0, maxX: 1000, minY: 0, maxY: 500 }, viewport, { pad: 40 });
    // usable: 720x320 -> min(0.72, 0.64)
    expect(view.k).toBeCloseTo(0.64, 10);
    expect(view.cx).toBe(500);
    expect(view.cy).toBe(250);
  });

  it("respects min/max scale", () => {
    const box = { minX: 0, maxX: 1000, minY: 0, maxY: 500 };
    expect(fitView(box, viewport, { pad: 40, maxK: 0.5 }).k).toBe(0.5);
    expect(fitView(box, viewport, { pad: 40, minK: 1 }).k).toBe(1);
  });

  it("zooms a single point to maxK instead of infinity", () => {
    const view = fitView({ minX: 5, maxX: 5, minY: 5, maxY: 5 }, viewport, { pad: 40, maxK: 16 });
    expect(view.k).toBe(16);
    expect(view.cx).toBe(5);
  });
});

describe("clampView", () => {
  it("stops panning at the world edges", () => {
    const clamped = clampView({ cx: 0, cy: 900, k: 2 }, { w: 800, h: 400 });
    expect(clamped.cx).toBe(200); // half viewport: 800 / (2*2)
    expect(clamped.cy).toBe(900);
  });

  it("locks a view wider than the world to its center", () => {
    const clamped = clampView({ cx: 0, cy: 0, k: 0.1 }, { w: 800, h: 400 });
    expect(clamped).toEqual({ cx: 1800, cy: 900, k: 0.1 });
  });
});

describe("zoomAt", () => {
  const viewport = { w: 800, h: 400 };

  it("keeps the world point under the cursor under the cursor", () => {
    const view = { cx: 1800, cy: 900, k: 1 };
    const zoomed = zoomAt(view, viewport, 0, 200, 2, { maxK: 16 });
    expect(zoomed.k).toBe(2);
    expect(zoomed.cx).toBe(1600);
    expect(zoomed.cy).toBe(900);
    // the world point that was at px=0 (x=1400) stays at px=0 after zooming
    expect(screenPoint(zoomed, viewport, 1400, 900)[0]).toBe(0);
  });

  it("clamps to the scale limits and no-ops at them", () => {
    const view = { cx: 1800, cy: 900, k: 1 };
    expect(zoomAt(view, viewport, 400, 200, 100, { maxK: 3 }).k).toBe(3);
    const stuck = zoomAt({ ...view, k: 3 }, viewport, 400, 200, 4, { maxK: 3 });
    expect(stuck).toEqual({ cx: 1800, cy: 900, k: 3 });
  });
});

describe("scaleLimits", () => {
  it("shows the whole world at kMin and allows deep zoom", () => {
    const limits = scaleLimits({ w: 800, h: 400 });
    expect(limits.kMin).toBeCloseTo((400 / 1800) * 0.95, 10);
    expect(limits.kMax).toBe(16);
  });
});

describe("unwrapNear", () => {
  it("returns the equivalent longitude within 180° of the reference", () => {
    expect(unwrapNear(139.65, -122.38)).toBeCloseTo(-220.35, 8);
    expect(unwrapNear(-122.38, -122.38)).toBeCloseTo(-122.38, 8);
    expect(unwrapNear(-170, 170)).toBeCloseTo(190, 8);
    expect(unwrapNear(0, 0)).toBe(0);
  });
});

describe("greatCirclePoints", () => {
  it("starts and ends exactly at the endpoints", () => {
    const from = { lat: 40.6413, lon: -73.7781 }; // JFK
    const to = { lat: 51.47, lon: -0.4543 }; // LHR
    const points = greatCirclePoints(from, to);
    expect(points[0]).toEqual(from);
    expect(points[points.length - 1]).toEqual({ lat: to.lat, lon: to.lon });
    expect(points.length).toBeGreaterThanOrEqual(3);
    expect(points.length).toBeLessThanOrEqual(64);
  });

  it("arcs over the North Atlantic between JFK and LHR", () => {
    const points = greatCirclePoints({ lat: 40.6413, lon: -73.7781 }, { lat: 51.47, lon: -0.4543 });
    const middle = points[Math.floor(points.length / 2)];
    // great-circle midpoint ~ (52.4N, 41.4W): north of both endpoints, mid-ocean
    expect(middle.lat).toBeGreaterThan(50);
    expect(middle.lat).toBeLessThan(55);
    expect(middle.lon).toBeGreaterThan(-50);
    expect(middle.lon).toBeLessThan(-30);
  });

  it("crosses the antimeridian without a 360° longitude jump (SFO to Tokyo)", () => {
    const from = { lat: 37.6188, lon: -122.375 };
    const to = { lat: 35.6762, lon: 139.6503 };
    const points = greatCirclePoints(from, to);
    // the target unwraps west of the start, so the whole arc stays west
    expect(points[points.length - 1].lon).toBeCloseTo(139.6503 - 360, 6);
    for (const point of points) {
      expect(point.lon).toBeLessThan(0);
      expect(point.lon).toBeGreaterThanOrEqual(from.lon - 180.001);
    }
    // the arc bulges north into the Pacific
    const middle = points[Math.floor(points.length / 2)];
    expect(middle.lat).toBeGreaterThan(45);
    expect(middle.lat).toBeLessThan(53);
  });

  it("returns the two endpoints unchanged when they coincide", () => {
    const points = greatCirclePoints({ lat: 10, lon: 20 }, { lat: 10, lon: 20 });
    expect(points).toEqual([{ lat: 10, lon: 20 }, { lat: 10, lon: 20 }]);
  });

  it("honors the point cap", () => {
    const points = greatCirclePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 100 }, 8);
    expect(points.length).toBeLessThanOrEqual(8);
  });

  it("falls back to flat interpolation for nearly antipodal points", () => {
    const points = greatCirclePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 179.999 });
    expect(points.length).toBeGreaterThan(2);
    for (const point of points) {
      expect(point.lat).toBeCloseTo(0, 6);
    }
  });
});

describe("wrapShifts", () => {
  it("needs no shifted copy inside the flat world", () => {
    expect(wrapShifts([{ lon: 40 }, { lon: 139 }])).toEqual([0]);
    expect(wrapShifts([{ lon: -100 }, { lon: -80 }])).toEqual([0]);
  });

  it("adds a +360 copy when the path dips below -180", () => {
    expect(wrapShifts([{ lon: -100 }, { lon: -220.35 }])).toEqual([0, 360]);
  });

  it("adds a -360 copy when the path exceeds +180", () => {
    expect(wrapShifts([{ lon: 40 }, { lon: 220 }])).toEqual([0, -360]);
  });
});

describe("topologyPaths", () => {
  // A 10°x10° square from (0,0), scale 1, translate 0: four arcs chained
  // head-to-tail, plus a reversed-arc triangle and a country with a hole.
  const topology = {
    type: "Topology",
    transform: { scale: [1, 1], translate: [0, 0] },
    arcs: [
      // deltas accumulate per arc; the first delta is the arc's absolute
      // start point (scale 1, translate 0), the rest are steps.
      [[0, 0], [10, 0]], // (0,0) -> (10,0)
      [[10, 0], [0, 10]], // (10,0) -> (10,10)
      [[10, 10], [-10, 0]], // (10,10) -> (0,10)
      [[0, 10], [0, -10]], // (0,10) -> (0,0)
      [[10, 10], [5, 5]], // (10,10) -> (15,15)
      [[15, 15], [-5, 5]], // (15,15) -> (10,20)
      [[10, 10], [0, 10]], // (10,10) -> (10,20)
      [[2, 2], [2, 0]], // (2,2) -> (4,2)
      [[4, 2], [0, 2]], // (4,2) -> (4,4)
      [[4, 4], [-2, 0]], // (4,4) -> (2,4)
      [[2, 4], [0, -2]], // (2,4) -> (2,2)
    ],
    objects: {
      countries: {
        type: "GeometryCollection",
        geometries: [
          { type: "Polygon", arcs: [[0, 1, 2, 3]] },
          { type: "MultiPolygon", arcs: [[[4, 5, -7]]] }, // -7 ~ 6: (10,20) -> (10,10) reversed
          { type: "Polygon", arcs: [[0, 1, 2, 3], [7, 8, 9, 10]] }, // square with a hole
        ],
      },
    },
  };

  it("decodes arcs, deduplicates shared endpoints, and closes rings", () => {
    const paths = topologyPaths(topology);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe("M1800 900L1900 900L1900 800L1800 800Z");
    // reversed arc index ~i: the triangle's last leg runs (10,20) -> (10,10)
    expect(paths[1]).toBe("M1900 800L1950 750L1900 700Z");
    // a country with a hole emits both rings in one path (evenodd fill)
    expect(paths[2]).toBe("M1800 900L1900 900L1900 800L1800 800ZM1820 880L1840 880L1840 860L1820 860Z");
  });
});

describe("world-outline dataset", () => {
  const paths = topologyPaths(outline.topology);

  it("decodes every country into a closed path in world units", () => {
    expect(paths.length).toBeGreaterThanOrEqual(170);
    let commands = 0;
    for (const path of paths) {
      expect(path).toMatch(/^M-?\d/);
      expect(path.endsWith("Z")).toBe(true);
      commands += path.match(/L/g)?.length ?? 0;
    }
    // 110m world outline: ~10k coordinates
    expect(commands).toBeGreaterThan(4000);
  });

  it("covers the world box laterally; Natural Earth crops the polar cap", () => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
      for (const match of path.matchAll(/(?:M|L)(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) {
        const x = Number(match[1]);
        const y = Number(match[2]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    expect(minX).toBeCloseTo(0, 0); // lon -180
    expect(maxX).toBeCloseTo(3600, 0); // lon +180
    // 110m countries crop both polar caps (~83.6°N / ~85.6°S)
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(minY).toBeLessThanOrEqual(100);
    expect(maxY).toBeGreaterThanOrEqual(1700);
    expect(maxY).toBeLessThanOrEqual(1800);
  });

  it("records the source hash for refreshes", () => {
    expect(outline.sources.outline_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("latencyStyle", () => {
  it("interpolates green-thin (fast) to red-thick (slow)", () => {
    expect(latencyStyle(10, 100)).toEqual({ color: "hsl(131, 75%, 39%)", width: 1.75 });
    expect(latencyStyle(100, 100)).toEqual({ color: "hsl(0, 75%, 46%)", width: 4 });
  });

  it("treats a zero max as fully fast and clamps outliers", () => {
    expect(latencyStyle(5, 0)).toEqual({ color: "hsl(145, 75%, 38%)", width: 1.5 });
    expect(latencyStyle(300, 100)).toEqual({ color: "hsl(0, 75%, 46%)", width: 4 });
  });
});

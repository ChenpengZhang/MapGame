// test/stubs.mjs —— 测试共用的浏览器桩件（DOM / 高德地图 / localStorage / fetch / TransitRouter）。
// 供 test-user-journey.mjs 等前端流程测试复用，避免每个测试文件复制一份桩件。

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

export function makeEl(id) {
  const el = {
    id, tagName: 'DIV', textContent: '', innerHTML: '', value: '', checked: false,
    style: {}, isConnected: true, children: [], __ev: {},
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x); },
      remove(...c) { for (const x of c) this._set.delete(x); },
      toggle(c, force) { const w = force === undefined ? !this._set.has(c) : !!force; if (w) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (this.__ev[type] = this.__ev[type] || []).push(fn); },
    dispatch(type, evt) { for (const fn of this.__ev[type] || []) fn(evt || {}); },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl(id + '::child'); },
    querySelectorAll() { return []; },
  };
  return el;
}

function makeCanvas() {
  return {
    tagName: 'CANVAS', width: 0, height: 0, style: {}, isConnected: true,
    getContext() { return { beginPath() {}, arc() {}, fill() {}, stroke() {}, fillStyle: '', lineWidth: 0, strokeStyle: '' }; },
    toDataURL() { return 'data:image/png;base64,AAAA'; },
  };
}

/** 全局唯一 DOM 元素表（每个 id 一个 stub 元素，可跨测试步骤复用） */
export const elements = new Map();
export function installDOM() {
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
    createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeEl('new-' + tag); },
    head: makeEl('head'), body: makeEl('body'),
    querySelectorAll() { return []; }, addEventListener() {},
  };
  globalThis.window = globalThis;
  globalThis.innerHeight = 800;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

export const store = new Map();
export function installStorage() {
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
}

/** fetch 桩：默认读 sample.json（兜底数据），MG_FULL=1 时读真实全量数据 */
export function installFetch(useFull) {
  const hdr = { get: () => null };
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0].replace(/^\//, '');
    if (u.includes('beijing-transit.json') && !useFull) {
      return { ok: false, status: 404, headers: hdr, json: async () => { throw new Error('404'); } };
    }
    const text = fs.readFileSync(path.join(ROOT, u), 'utf8');
    return { ok: true, status: 200, headers: hdr, json: async () => JSON.parse(text) };
  };
}

/** 高德地图桩件：记录创建出来的覆盖物（供断言） */
export const created = { massMarks: [], polylines: [], circles: [], markers: [] };
class BoundsStub {
  constructor(sw, ne) { this.sw = sw; this.ne = ne; }
  getSouthWest() { return { getLng: () => this.sw[0], getLat: () => this.sw[1] }; }
  getNorthEast() { return { getLng: () => this.ne[0], getLat: () => this.ne[1] }; }
}
class MapStub {
  constructor(id, opts) { this.id = id; this.center = (opts && opts.center) || [0, 0]; this.zoom = 10; this.__ev = {}; this.container = makeEl('map-container'); }
  getContainer() { return this.container; }
  getZoom() { return this.zoom; }
  setZoom(z) { this.zoom = z; }
  setZoomAndCenter(z) { this.zoom = z; }
  getCenter() { return this.center; }
  setBounds() {}
  getBounds() { return new BoundsStub([115.0, 39.0], [117.5, 41.0]); }
  setStatus() {}
  on(evt, fn) { (this.__ev[evt] = this.__ev[evt] || []).push(fn); }
}
class OverlayStub {
  constructor(opts) { this.__opts = Object.assign({ strokeOpacity: 1, opacity: 0.9 }, opts); this.__ev = {}; this.map = null; }
  setMap(m) { this.map = m; }
  setOptions(o) { Object.assign(this.__opts, o); }
  getOptions() { return this.__opts; }
  on(evt, fn) { (this.__ev[evt] = this.__ev[evt] || []).push(fn); }
}
class PolylineStub extends OverlayStub { constructor(o) { super(o); created.polylines.push(this); } }
class CircleStub extends OverlayStub { constructor(o) { super(o); created.circles.push(this); } }
class MarkerStub extends OverlayStub { constructor(o) { super(o); created.markers.push(this); } }
class MassMarksStub extends OverlayStub {
  constructor(data, opts) { super(opts); this.data = data; this.__baseOpacity = 0.9; this.shown = false; created.massMarks.push(this); }
  setData(d) { this.data = d; }
  show() { this.shown = true; }
  hide() { this.shown = false; }
}

export function installAMap() {
  globalThis.AMap = {
    __backend: 'leaflet',
    Map: MapStub,
    MassMarks: MassMarksStub,
    Polyline: PolylineStub,
    Circle: CircleStub,
    Marker: MarkerStub,
    Bounds: BoundsStub,
    Pixel: class { constructor(x, y) { this.x = x; this.y = y; } },
    Size: class { constructor(w, h) { this.w = w; this.h = h; } },
    LngLat: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } },
    plugin: (name, cb) => setTimeout(cb, 0),
  };
}

export function installRouter() {
  globalThis.window.TransitRouter = require('../shared/router.js');
}

/** 一键安装全部桩件 */
export function installAllStubs({ useFull = false } = {}) {
  installDOM();
  installStorage();
  installFetch(useFull);
  installAMap();
  installRouter();
}

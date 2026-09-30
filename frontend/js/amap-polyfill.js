/*
 * 免 Key 地图后端（Leaflet + OpenStreetMap）：
 * 用与高德 JS API 相同的最小 API 面实现 AMap 兼容层，让 app.js 无需改动即可跑在 OSM 上。
 *
 * 生效时机：未在设置里配置高德 Key 时，bootstrap 会加载 Leaflet，此时本文件定义的 AMap 生效；
 * 配置了 Key 并加载真实高德脚本后，高德会覆盖 window.AMap，本实现被替换。
 *
 * 坐标体系（关键）：游戏数据、路由、关卡坐标统一用 GCJ-02（与高德一致）。
 * 本兼容层是唯一知道 OSM 用 WGS-84 的地方：所有"送进 Leaflet"的坐标在入口统一
 * GCJ-02 → WGS-84，所有"从 Leaflet 取回"的坐标在出口统一 WGS-84 → GCJ-02。
 * 这样 app.js 完全无感知，路由/交互在两端结果完全一致（高德路径零改动、零污染）。
 *
 * 依赖：Leaflet（外部 CDN，需先于构造加载）。
 */
(function () {
  'use strict';
  if (window.AMap) return; // 已有高德（或已被覆盖），不重复定义

  // ---------- GCJ-02 ↔ WGS-84 ----------
  const PI = Math.PI;
  const A = 6378245.0;
  const EE = 0.00669342162296594323;
  function outOfChina(lng, lat) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function transformLat(x, y) {
    let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += ((20.0 * Math.sin(6.0 * x * PI)) + (20.0 * Math.sin(2.0 * x * PI))) * 2.0 / 3.0;
    r += ((20.0 * Math.sin(y * PI)) + (40.0 * Math.sin((y / 3.0) * PI))) * 2.0 / 3.0;
    r += ((160.0 * Math.sin((y / 12.0) * PI)) + (320.0 * Math.sin((y * PI) / 30.0))) * 2.0 / 3.0;
    return r;
  }
  function transformLng(x, y) {
    let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += ((20.0 * Math.sin(6.0 * x * PI)) + (20.0 * Math.sin(2.0 * x * PI))) * 2.0 / 3.0;
    r += ((20.0 * Math.sin(x * PI)) + (40.0 * Math.sin((x / 3.0) * PI))) * 2.0 / 3.0;
    r += ((150.0 * Math.sin((x / 12.0) * PI)) + (300.0 * Math.sin((x / 30.0) * PI))) * 2.0 / 3.0;
    return r;
  }
  function wgs2gcj(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * PI;
    let magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
    dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }
  function gcj2wgs(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let wLng = lng, wLat = lat;
    for (let i = 0; i < 12; i++) {
      const [gLng, gLat] = wgs2gcj(wLng, wLat);
      wLng -= gLng - lng;
      wLat -= gLat - lat;
    }
    return [wLng, wLat];
  }
  // GCJ-02 [lng,lat] → WGS-84 [lat,lng]（Leaflet 用 [lat,lng]）
  function gcj2leaflet(c) {
    const [lng, lat] = gcj2wgs(c[0], c[1]);
    return [lat, lng];
  }

  const AMap = { __polyfill: true, __backend: 'leaflet' };

  AMap.Pixel = class { constructor(x, y) { this.x = x; this.y = y; } };
  AMap.Size = class { constructor(w, h) { this.w = w; this.h = h; } };
  AMap.LngLat = class {
    constructor(lng, lat) { this.lng = lng; this.lat = lat; }
    getLng() { return this.lng; }
    getLat() { return this.lat; }
  };
  function toLngLat(x) {
    if (x && typeof x.getLng === 'function') return x;
    return new AMap.LngLat(Number(x[0]), Number(x[1]));
  }
  AMap.Bounds = class {
    constructor(sw, ne) { this._sw = toLngLat(sw); this._ne = toLngLat(ne); }
    getSouthWest() { return this._sw; }
    getNorthEast() { return this._ne; }
  };

  AMap.Map = class {
    constructor(el, opts) {
      opts = opts || {};
      const [lng, lat] = opts.center || [116.397, 39.909];
      // 入口：GCJ-02 center → WGS-84
      const c = gcj2leaflet([lng, lat]);
      const m = L.map(el, {
        center: c,
        zoom: opts.zoom || 11,
        zoomSnap: 0, // 按实际视野精确缩放，避免整数级别让范围圈显得过小
        scrollWheelZoom: !opts.scrollWheel,
        zoomControl: false, // 游戏自带滚轮惯性缩放，去掉 Leaflet 默认的 +/- 按钮
        attributionControl: true,
      });
      this._tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
      // 去掉 Leaflet 默认的“国旗 + Leaflet”前缀，只保留 OpenStreetMap 版权署名（OSM 许可要求）
      if (m.attributionControl) m.attributionControl.setPrefix(false);
      this._map = m;
      // 与原生高德一致：地图点击事件带 GCJ-02 的 e.lnglat（关卡编辑器用它放置起终点）。
      // 构造时最先注册，Leaflet 按注册顺序调用，后注册的监听拿到的是同一个已补上坐标的事件对象。
      m.on('click', (ev) => {
        if (!ev.latlng || ev.lnglat) return;
        const [lng, lat] = wgs2gcj(ev.latlng.lng, ev.latlng.lat);
        ev.lnglat = new AMap.LngLat(lng, lat);
      });
      this._focusing = false;
      const interruptFocus = () => {
        if (!this._focusing) return;
        this._focusing = false;
        this._focusComplete = null;
        m.stop();
      };
      // 手动操作立即接管，不让飞行动画与后续拖动或滚轮争夺视野。
      for (const event of ['pointerdown', 'wheel', 'touchstart']) {
        m.getContainer().addEventListener(event, interruptFocus, { capture: true, passive: true });
      }
      m.on('moveend', () => {
        const completed = this._focusing ? this._focusComplete : null;
        this._focusing = false;
        this._focusComplete = null;
        completed?.();
      });
    }
    enableNativeWheelZoom(speed = 0.5) {
      this.setWheelZoomSpeed(speed);
      this._map.scrollWheelZoom.enable();
    }
    setWheelZoomSpeed(speed) {
      this._map.options.wheelPxPerZoomLevel = 180 - Math.max(0, Math.min(1, speed)) * 120;
    }
    /** 显示/隐藏底图瓦片（无尽模式“盲棋”用）；覆盖物不受影响 */
    setBaseLayerVisible(visible) {
      if (visible) { if (!this._map.hasLayer(this._tiles)) this._tiles.addTo(this._map); }
      else this._tiles.remove();
    }
    getZoom() { return this._map.getZoom(); }
    setZoom(z) { this._map.setZoom(z); }
    getCenter() { // 出口：WGS-84 → GCJ-02
      const c = this._map.getCenter();
      const [lng, lat] = wgs2gcj(c.lng, c.lat);
      return new AMap.LngLat(lng, lat);
    }
    setZoomAndCenter(z, center) { // 入口：GCJ-02 → WGS-84
      const c = (center && center.getLng) ? center : center;
      this._map.setView(gcj2leaflet([c.getLng(), c.getLat()]), z, { animate: false });
    }
    getBounds() { // 出口：WGS-84 → GCJ-02
      const b = this._map.getBounds();
      const sw = wgs2gcj(b.getWest(), b.getSouth());
      const ne = wgs2gcj(b.getEast(), b.getNorth());
      return new AMap.Bounds(sw, ne);
    }
    setBounds(bounds, immediately, padding) { // 入口：GCJ-02 → WGS-84
      this._focusing = false;
      this._focusComplete = null;
      this._map.stop();
      const p = padding || [0, 0, 0, 0]; // [top, right, bottom, left]
      this._map.fitBounds(
        [
          gcj2leaflet([bounds.getSouthWest().getLng(), bounds.getSouthWest().getLat()]),
          gcj2leaflet([bounds.getNorthEast().getLng(), bounds.getNorthEast().getLat()]),
        ],
        {
          paddingTopLeft: L.point(p[3] || 0, p[0] || 0),
          paddingBottomRight: L.point(p[1] || 0, p[2] || 0),
          animate: false,
        }
      );
    }
    focusBounds(bounds, padding = [0, 0, 0, 0], onComplete) {
      const target = [
        gcj2leaflet([bounds.getSouthWest().getLng(), bounds.getSouthWest().getLat()]),
        gcj2leaflet([bounds.getNorthEast().getLng(), bounds.getNorthEast().getLat()]),
      ];
      this._focusing = false;
      this._focusComplete = null;
      this._map.stop(); // 连续点击时从当前视野开始聚焦
      const framing = {
        paddingTopLeft: L.point(padding[3], padding[0]),
        paddingBottomRight: L.point(padding[1], padding[2]),
      };
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) {
        this._map.fitBounds(target, { ...framing, animate: false });
        onComplete?.();
      }
      else {
        this._focusing = true;
        this._focusComplete = onComplete;
        this._map.flyToBounds(target, { ...framing, animate: true, duration: 0.8 });
      }
    }
    setStatus(s) {
      const m = this._map;
      if (s.dragEnable === false) m.dragging.disable(); else if (s.dragEnable === true) m.dragging.enable();
      if (s.zoomEnable === false) { m.scrollWheelZoom.disable(); m.doubleClickZoom.disable(); m.touchZoom.disable(); }
      else if (s.zoomEnable === true) { m.scrollWheelZoom.enable(); m.doubleClickZoom.enable(); m.touchZoom.enable(); }
    }
    getContainer() { return this._map.getContainer(); }
    on(e, cb) { this._map.on(e === 'zoomchange' ? 'zoom' : e, cb); }
    off(e, cb) { this._map.off(e === 'zoomchange' ? 'zoom' : e, cb); }
    addLayer(l) { this._map.addLayer(l); }
    removeLayer(l) { this._map.removeLayer(l); }
  };

  function attach(o, m) { if (m) m.addLayer(o); else o.remove(); }

  // 高德覆盖物依赖 zIndex；Leaflet 默认却只按“加入先后”叠放。候选网络每次重绘都
  // 晚于玩家路线创建，若不映射层级就会把已规划实线完全盖住。为每个高德 zIndex
  // 建立对应 pane，让两套后端遵守同一套图层顺序。
  function paneFor(m, zIndex) {
    if (!m || !m._map || !Number.isFinite(Number(zIndex))) return null;
    const z = Math.round(Number(zIndex));
    const name = 'amap-z-' + z;
    let pane = m._map.getPane(name);
    if (!pane) pane = m._map.createPane(name);
    pane.style.zIndex = String(400 + z);
    return name;
  }

  function moveToPane(layer, m, zIndex) {
    const pane = paneFor(m, zIndex);
    if (pane) layer.options.pane = pane;
  }

  // 已挂载的矢量图形改层级：把原 SVG 元素移到目标 pane 的渲染器里（同 Leaflet bringToFront 的做法）。
  // 不能 remove + addLayer：那会在鼠标下方新建元素，旧元素的 mouseout 永远不会触发，
  // 路线悬停置顶后就再也恢复不了原层级。各 pane 渲染器坐标系一致，原渲染器照常负责重绘。
  function restackPath(layer, m, zIndex) {
    const pane = paneFor(m, zIndex);
    if (!pane) return;
    layer.options.pane = pane;
    const renderer = m._map.getRenderer(layer);
    const root = renderer && renderer._rootGroup;
    if (root && layer._path) root.appendChild(layer._path);
    else { layer.remove(); m._map.addLayer(layer); }
  }

  AMap.Polyline = class {
    constructor(opts) {
      // 入口：GCJ-02 path → WGS-84
      const pts = (opts.path || []).map(([lng, lat]) => gcj2leaflet([lng, lat]));
      this._o = L.polyline(pts, {
        color: opts.strokeColor,
        weight: opts.strokeWeight || 2,
        opacity: opts.strokeOpacity != null ? opts.strokeOpacity : 1,
        dashArray: opts.dashArray,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: opts.interactive !== false, // 高亮/步行等瞬态线不拦截鼠标，避免悬浮站点点位闪烁
      });
      this._z = opts.zIndex;
      this._map = null;
    }
    setMap(m) {
      this._map = m || null;
      if (m) moveToPane(this._o, m, this._z);
      attach(this._o, m);
    }
    setOptions(o) {
      const cur = this._o.options;
      this._o.setStyle({
        color: o.strokeColor !== undefined ? o.strokeColor : cur.color,
        weight: o.strokeWeight !== undefined ? o.strokeWeight : cur.weight,
        opacity: o.strokeOpacity !== undefined ? o.strokeOpacity : cur.opacity,
        dashArray: o.dashArray !== undefined ? o.dashArray : cur.dashArray,
      });
      if (o.zIndex !== undefined && o.zIndex !== this._z) {
        this._z = o.zIndex;
        if (this._map) restackPath(this._o, this._map, this._z);
      }
    }
    on(e, cb) { this._o.on(e, cb); }
    getOptions() { return { strokeOpacity: this._o.options.opacity }; }
  };

  AMap.Circle = class {
    constructor(opts) {
      // 入口：GCJ-02 center → WGS-84
      this._o = L.circle(gcj2leaflet([opts.center[0], opts.center[1]]), {
        radius: opts.radius || 100,
        color: opts.strokeColor || '#fff',
        weight: opts.strokeWeight || 2,
        opacity: opts.strokeOpacity != null ? opts.strokeOpacity : 1,
        fillColor: opts.fillColor || '#e74c3c',
        fillOpacity: opts.fillOpacity != null ? opts.fillOpacity : 0.25,
        interactive: opts.interactive !== false, // 高亮圈不拦截鼠标
      });
      this._z = opts.zIndex;
      this._map = null;
    }
    setMap(m) {
      this._map = m || null;
      if (m) moveToPane(this._o, m, this._z);
      attach(this._o, m);
    }
    setOptions(o) {
      const cur = this._o.options;
      this._o.setStyle({
        color: o.strokeColor !== undefined ? o.strokeColor : cur.color,
        weight: o.strokeWeight !== undefined ? o.strokeWeight : cur.weight,
        opacity: o.strokeOpacity !== undefined ? o.strokeOpacity : cur.opacity,
        fillColor: o.fillColor !== undefined ? o.fillColor : cur.fillColor,
        fillOpacity: o.fillOpacity !== undefined ? o.fillOpacity : cur.fillOpacity,
      });
      if (o.zIndex !== undefined && o.zIndex !== this._z) {
        this._z = o.zIndex;
        if (this._map) restackPath(this._o, this._map, this._z);
      }
    }
    on(e, cb) { this._o.on(e, cb); }
    getOptions() { return { strokeOpacity: this._o.options.opacity }; }
  };

  AMap.Marker = class {
    constructor(opts) {
      // 高德 offset = 内容左上角相对坐标点的偏移；Leaflet 的 iconAnchor 正好是它的相反数。
      // 不能写死 (12,12)：那只对 offset(-12,-12) 的图钉成立，教学提示等 offset(0,0) 的标记会偏 12px。
      const off = opts.offset || { x: -12, y: -12 };
      const icon = L.divIcon({
        html: opts.content || '',
        className: 'amap-pin-marker',
        iconSize: L.point(24, 24),
        iconAnchor: L.point(-off.x, -off.y),
      });
      // 入口：GCJ-02 position → WGS-84
      // 教学文字等纯展示 Marker 必须允许点击穿透，否则会盖住同坐标的公交站点。
      const interactive = opts.clickable !== false;
      this._o = L.marker(gcj2leaflet([opts.position[0], opts.position[1]]), {
        icon, interactive, keyboard: interactive,
      });
      this._z = opts.zIndex || 0;
      this._map = null;
    }
    setMap(m) {
      this._map = m || null;
      if (m) {
        moveToPane(this._o, m, this._z);
        m.addLayer(this._o);
      } else this._o.remove();
    }
    on(e, cb) { this._o.on(e, cb); }
    setPosition(p) { // 入口：GCJ-02 → WGS-84
      const lng = p.getLng ? p.getLng() : p[0], lat = p.getLat ? p.getLat() : p[1];
      this._o.setLatLng(gcj2leaflet([lng, lat]));
    }
    setOptions(o) {
      if (o.zIndex !== undefined && o.zIndex !== this._z) {
        this._z = o.zIndex;
        if (this._map) {
          this._o.remove();
          moveToPane(this._o, this._map, this._z);
          this._map.addLayer(this._o);
        }
      }
    }
    getOptions() { return {}; }
  };

  // 海量点：每个站两层 —— 小视觉圆点（非交互）+ 大透明命中圆（交互）。
  // 命中圆半径：桌面 9px 精确点选；触摸设备 16px（约 32px 直径，更接近手指点选目标）。
  // 悬浮/点击挂在命中圆上；数据对象（含 GCJ-02 lnglat）原样保留，事件回传时不改坐标系。
  const TOUCH = !!(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const HIT_R = TOUCH ? 16 : 9;
  AMap.MassMarks = class {
    constructor(data, opts) {
      this._data = data || [];
      this._map = null;
      this._handlers = {};
      this._base = (opts && opts.opacity) != null ? opts.opacity : 0.9;
      this.__baseOpacity = this._base;
      this.__canvas = null;
      this._z = opts && opts.zIndex;
      this._paneName = null;
      this._interactive = !(opts && opts.interactive === false);
      this._group = L.layerGroup();
      this._rebuild();
    }
    _rebuild() {
      this._group.clearLayers();
      for (const d of this._data) {
        const metro = d.style === 0;
        const walk = d.style === 2; // 步行可达站（红色，区别于蓝色公交站和橙色地铁站）
        const lineStop = !walk && !!d.lineColor;
        // 入口：GCJ-02 lnglat → WGS-84（仅渲染用；d 本身保持 GCJ-02 供事件回传）
        const ll = gcj2leaflet([d.lnglat[0], d.lnglat[1]]);
        const dot = L.circleMarker(ll, {
          radius: metro ? 6 : walk ? 3 : 3.5,
          color: lineStop ? d.lineColor : '#fff', weight: lineStop ? 2 : 1,
          fillColor: lineStop ? '#fff' : metro ? '#f39c12' : walk ? '#e74c3c' : '#3498db',
          fillOpacity: this._base,
          opacity: this._base,
          pane: this._paneName || 'overlayPane',
          interactive: false,
        });
        this._group.addLayer(dot);
        if (!this._interactive) continue;
        const hit = L.circleMarker(ll, {
          radius: HIT_R,
          stroke: false, fill: true, fillOpacity: 0,
          pane: this._paneName || 'overlayPane',
          interactive: true,
        });
        const dd = d;
        hit.on('mouseover', () => this._fire('mouseover', { data: dd }));
        hit.on('mouseout', () => this._fire('mouseout', { data: dd }));
        hit.on('click', () => this._fire('click', { data: dd }));
        this._group.addLayer(hit);
      }
    }
    _fire(type, obj) {
      const a = this._handlers[type];
      if (a) for (let i = 0; i < a.length; i++) a[i](obj);
    }
    on(type, cb) { (this._handlers[type] = this._handlers[type] || []).push(cb); }
    setMap(m) {
      this._map = m;
      if (m) {
        this._paneName = paneFor(m, this._z);
        this._rebuild();
        m.addLayer(this._group);
      } else this._group.remove();
    }
    show() { if (this._map) this._map.addLayer(this._group); }
    hide() { if (this._map) this._map.removeLayer(this._group); }
    setData(data) { this._data = data || []; this._rebuild(); }
    setOptions(o) {
      if (o.opacity !== undefined) {
        this._base = o.opacity;
        this.__baseOpacity = o.opacity;
        this._group.eachLayer((l) => {
          if (l.options.interactive) return; // 只淡化视觉点，命中圆保持透明
          l.setStyle({ fillOpacity: o.opacity, opacity: o.opacity });
        });
      }
    }
  };

  // 占位：步行已改用直线距离估算，不再调用高德步行接口
  AMap.plugin = function (name, cb) { if (cb) cb(); };
  AMap.Walking = class { constructor() {} search() {} };

  window.AMap = AMap;
})();

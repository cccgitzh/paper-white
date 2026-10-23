/* ===============================================================
   crop.js —— 透视裁剪交互层

   编辑态：主画布显示「未处理的旋转整图」，上面盖一层 overlay 画四角框；
   右下角小窗实时显示「透视矫正 + 去底」后的结果，所见即所得。
   =============================================================== */
(function (DC) {
  "use strict";

  const { $, makeCanvas } = DC.utils;
  const S = DC.state;

  const HIT_CORNER = 16;
  const HIT_EDGE = 11;
  const INSET_W = 168;
  const INSET_H = 212;

  let el = null;         // overlay canvas
  let g = null;          // 2d context
  let view = { w: 0, h: 0, dpr: 1 };
  let drag = null;
  let quadBefore = null;
  let insetRaf = 0;

  /* ---------- 坐标换算 ---------- */
  function quadPx() {
    return S.quad.map((p) => ({ x: p.x * view.w, y: p.y * view.h }));
  }

  function polyPath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  function pointInQuad(pt, pts) {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      const intersect =
        yi > pt.y !== yj > pt.y &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  /* ---------- 绘制 ---------- */
  function draw() {
    if (!g || !S.quad) return;
    const pts = quadPx();

    g.clearRect(0, 0, view.w, view.h);

    /* 四边形外压暗 */
    g.save();
    g.beginPath();
    g.rect(0, 0, view.w, view.h);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
    g.fillStyle = "rgba(17,24,39,.58)";
    g.fill("evenodd");
    g.restore();

    /* 三分参考线 */
    g.save();
    g.strokeStyle = "rgba(255,255,255,.24)";
    g.lineWidth = 1;
    for (let k = 1; k <= 2; k++) {
      const t = k / 3;
      const p1 = lerpPt(pts[0], pts[1], t);
      const p2 = lerpPt(pts[3], pts[2], t);
      const p3 = lerpPt(pts[0], pts[3], t);
      const p4 = lerpPt(pts[1], pts[2], t);
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
      g.beginPath(); g.moveTo(p3.x, p3.y); g.lineTo(p4.x, p4.y); g.stroke();
    }
    g.restore();

    /* 边框：白色描边打底 + 蓝色主线，保证在深浅背景上都可见 */
    g.save();
    polyPath(g, pts);
    g.lineJoin = "round";
    g.strokeStyle = "rgba(255,255,255,.9)";
    g.lineWidth = 4;
    g.stroke();
    g.strokeStyle = "#2f6df6";
    g.lineWidth = 2;
    g.stroke();
    g.restore();

    /* 边中点手柄 */
    g.save();
    for (let i = 0; i < 4; i++) {
      const m = lerpPt(pts[i], pts[(i + 1) % 4], 0.5);
      g.beginPath();
      g.arc(m.x, m.y, 4.5, 0, Math.PI * 2);
      g.fillStyle = "rgba(255,255,255,.95)";
      g.fill();
      g.strokeStyle = "#2f6df6";
      g.lineWidth = 1.6;
      g.stroke();
    }
    g.restore();

    /* 四角手柄 */
    g.save();
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      g.beginPath();
      g.arc(p.x, p.y, 8, 0, Math.PI * 2);
      g.fillStyle = "#fff";
      g.shadowColor = "rgba(17,24,39,.35)";
      g.shadowBlur = 6;
      g.shadowOffsetY = 1;
      g.fill();
      g.shadowColor = "transparent";
      g.strokeStyle = "#2f6df6";
      g.lineWidth = 2.5;
      g.stroke();

      g.beginPath();
      g.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      g.fillStyle = "#2f6df6";
      g.fill();
    }
    g.restore();
  }

  function lerpPt(a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /* ---------- 布局：overlay 必须与 #preview 的显示矩形严格重合 ---------- */
  function layout() {
    const stage = $("stage").getBoundingClientRect();
    const r = $("preview").getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;

    el.style.left = (r.left - stage.left) + "px";
    el.style.top = (r.top - stage.top) + "px";
    el.style.width = r.width + "px";
    el.style.height = r.height + "px";

    const dpr = window.devicePixelRatio || 1;
    el.width = Math.max(1, Math.round(r.width * dpr));
    el.height = Math.max(1, Math.round(r.height * dpr));

    g = el.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    view.w = r.width;
    view.h = r.height;
    view.dpr = dpr;
  }

  /* ---------- 命中测试 ---------- */
  function hitTest(pt) {
    const pts = quadPx();

    for (let i = 0; i < 4; i++) {
      if (Math.hypot(pt.x - pts[i].x, pt.y - pts[i].y) <= HIT_CORNER) {
        return { type: "corner", idx: i };
      }
    }
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      if (distToSegment(pt, a, b) <= HIT_EDGE) {
        return { type: "edge", idx: i };
      }
    }
    if (pointInQuad(pt, pts)) return { type: "move", idx: -1 };
    return null;
  }

  /* ---------- 指针事件 ---------- */
  function localPoint(e) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    if (!S.cropMode) return;
    const pt = localPoint(e);
    const hit = hitTest(pt);
    if (!hit) return;
    e.preventDefault();
    drag = {
      type: hit.type,
      idx: hit.idx,
      start: pt,
      startQuad: DC.perspective.cloneQuad(S.quad),
    };
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!S.cropMode) return;
    const pt = localPoint(e);

    if (!drag) {
      const hit = hitTest(pt);
      el.style.cursor = !hit ? "default"
        : hit.type === "corner" ? "nwse-resize"
        : hit.type === "edge" ? "move"
        : "grab";
      return;
    }

    e.preventDefault();
    const dx = (pt.x - drag.start.x) / view.w;
    const dy = (pt.y - drag.start.y) / view.h;
    const baseW = view.baseW || 1000;
    const baseH = view.baseH || 1000;

    let next = null;
    if (drag.type === "corner") {
      const o = drag.startQuad[drag.idx];
      next = DC.perspective.moveCorner(
        drag.startQuad, drag.idx, o.x + dx, o.y + dy, baseW, baseH
      );
    } else if (drag.type === "edge") {
      next = DC.perspective.moveEdge(
        drag.startQuad, drag.idx, dx, dy, baseW, baseH
      );
    } else {
      next = DC.perspective.moveQuad(drag.startQuad, dx, dy);
    }

    /* 非法位置（越界 / 自交 / 边太短）直接丢弃，手柄停在最后一个合法位置 */
    if (!next) return;

    S.quad = next;
    S.srcRev++;
    draw();
    scheduleInset();
  }

  function onUp(e) {
    if (!drag) return;
    drag = null;
    el.releasePointerCapture && el.releasePointerCapture(e.pointerId);
    DC.store.commit();
    DC.app.updateStatus();
  }

  /* ---------- 实时小窗：矫正 + 去底后的效果 ---------- */
  function scheduleInset() {
    if (insetRaf) return;
    insetRaf = requestAnimationFrame(() => {
      insetRaf = 0;
      renderInset();
    });
  }

  function renderInset() {
    if (!S.cropMode || !S.quad) return;
    const canvas = $("cropPreview");

    const base = DC.geometry.buildBase(420);
    const warped = DC.perspective.warp(base, S.quad);
    const out = DC.enhance.process(warped, S.srcRev + "-inset");

    const s = Math.min(INSET_W / out.width, INSET_H / out.height);
    const w = Math.max(1, Math.round(out.width * s));
    const h = Math.max(1, Math.round(out.height * s));

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    const cx = canvas.getContext("2d");
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.imageSmoothingQuality = "high";
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, w, h);
    cx.drawImage(out, 0, 0, w, h);
  }

  /* ---------- 进出编辑态 ---------- */
  function enter() {
    if (!S.img || S.cropMode) return;
    quadBefore = S.quad ? DC.perspective.cloneQuad(S.quad) : null;
    if (!S.quad) S.quad = DC.perspective.defaultQuad();

    S.cropMode = true;
    document.body.classList.add("cropping");
    el.hidden = false;

    const base = DC.geometry.buildBase(DC.app.PREVIEW_MAX);
    view.baseW = base.width;
    view.baseH = base.height;
    DC.app.paintRaw(base);

    layout();
    draw();
    scheduleInset();
    DC.app.updateStatus();
  }

  function leave() {
    S.cropMode = false;
    drag = null;
    document.body.classList.remove("cropping");
    el.hidden = true;
    if (g) g.clearRect(0, 0, el.width, el.height);
  }

  function apply() {
    if (!S.cropMode) return;
    leave();
    S.srcRev++;
    DC.store.commit();
    DC.app.render();
    DC.app.toast("已应用透视裁剪", "ok");
  }

  function cancel() {
    if (!S.cropMode) return;
    S.quad = quadBefore ? DC.perspective.cloneQuad(quadBefore) : null;
    S.srcRev++;
    leave();
    DC.app.render();
  }

  function reset() {
    if (!S.cropMode) return;
    S.quad = DC.perspective.defaultQuad();
    S.srcRev++;
    draw();
    scheduleInset();
    DC.app.updateStatus();
  }

  function init() {
    el = $("cropOverlay");
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    $("cropApply").addEventListener("click", apply);
    $("cropCancel").addEventListener("click", cancel);
    $("cropReset").addEventListener("click", reset);

    window.addEventListener("resize", () => {
      if (!S.cropMode) return;
      layout();
      draw();
    });
  }

  DC.crop = {
    init, enter, apply, cancel, reset,
    isActive: () => S.cropMode,
    onResize() { if (S.cropMode) { layout(); draw(); } },
  };
})(window.DC);

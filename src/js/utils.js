/* ===============================================================
   utils.js —— 无依赖的小工具集合
   =============================================================== */
window.DC = window.DC || {};

(function (DC) {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** 创建离屏画布 */
  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /** 取画布的 2D 上下文（不保留 alpha 时可提速，这里统一默认） */
  function ctx2d(canvas, opts) {
    return canvas.getContext("2d", opts || { willReadFrequently: true });
  }

  /** 触发浏览器下载 */
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /** 把毫秒格式化成“12 ms / 1.2 s” */
  function fmtMs(ms) {
    if (ms < 1000) return Math.round(ms) + " ms";
    return (ms / 1000).toFixed(1) + " s";
  }

  /* ---------- Toast ---------- */
  const toastWrap = () => $("toastWrap");

  function toast(msg, type, duration) {
    const wrap = toastWrap();
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    el.textContent = msg;
    wrap.appendChild(el);
    const ttl = duration || (type === "err" ? 3600 : 2200);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    }, ttl);
  }

  /* ---------- 节流：一帧最多执行一次 ---------- */
  function rafThrottle(fn) {
    let scheduled = false;
    let lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn.apply(null, lastArgs);
      });
    };
  }

  /** 等两帧，确保样式/布局已经落定（用于测量元素尺寸） */
  function nextFrame() {
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  }

  /* ---------- 文件名校验 ---------- */
  function safeName(name) {
    return (name || "image").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
  }

  DC.utils = {
    $, $$, clamp, makeCanvas, ctx2d, download, fmtBytes, fmtMs,
    toast, rafThrottle, nextFrame, safeName,
  };
})(window.DC);

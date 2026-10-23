/* ===============================================================
   state.js —— 全局状态、参数持久化、撤销/重做
   =============================================================== */
(function (DC) {
  "use strict";

  const LS_KEY = "paperwhite.params.v1";

  const DEFAULT_PARAMS = {
    mode: "gray",      // gray | color
    strength: 100,     // 去底强度 0-100
    radius: 10,        // 背景范围 3-30 (%)
    black: 40,         // 黑场 0-180
    white: 252,        // 白场 180-255
    sharpen: 20,       // 锐化 0-100
    invert: false,
    format: "png",     // png | jpeg | webp
    quality: 92,
  };

  const DEFAULT_PRINT = {
    paper: "A4",
    customW: 210,
    customH: 297,
    orientation: "auto",  // auto | portrait | landscape
    margin: 10,
    fit: "contain",       // contain | cover
  };

  const S = {
    /* 图像 */
    img: null,        // 原始画布（全分辨率）
    srcW: 0,
    srcH: 0,
    name: "image",
    meta: "",

    /* 几何 */
    rotation: 0,      // 0 / 90 / 180 / 270
    angle: 0,         // 微调倾斜（度）
    quad: null,       // 透视裁剪四角，归一化坐标，顺序 TL,TR,BR,BL

    /* 参数 */
    params: Object.assign({}, DEFAULT_PARAMS),
    print: Object.assign({}, DEFAULT_PRINT),

    /* 运行时缓存 */
    paperFill: null,
    bgCache: new Map(),
    srcRev: 0,        // 每次图像/几何变化 +1，用于让背景缓存失效
    busy: false,
    cropMode: false,
    lastRenderMs: 0,
    outW: 0,
    outH: 0,
  };

  /* ---------- 持久化（只存参数，不存图像） ---------- */
  function loadParams() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        if (data.params) Object.assign(S.params, data.params);
        if (data.print) Object.assign(S.print, data.print);
      }
    } catch (e) {
      /* localStorage 不可用（隐私模式 / file:// 限制）时静默降级 */
    }
  }

  let saveTimer = null;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({ params: S.params, print: S.print })
        );
      } catch (e) { /* 忽略配额/权限错误 */ }
    }, 400);
  }

  /* ---------- 快照与撤销栈 ---------- */
  const MAX_HISTORY = 40;
  const history = { stack: [], index: -1 };

  function snapshot() {
    return JSON.stringify({
      params: S.params,
      rotation: S.rotation,
      angle: S.angle,
      quad: S.quad,
    });
  }

  function restore(snap) {
    const d = JSON.parse(snap);
    S.params = Object.assign({}, DEFAULT_PARAMS, d.params);
    S.rotation = d.rotation || 0;
    S.angle = d.angle || 0;
    S.quad = d.quad || null;
    S.srcRev++;
    S.bgCache.clear();
  }

  /** 提交一个可撤销的历史点（在状态变更“之后”调用） */
  function commit() {
    const snap = snapshot();
    if (history.index >= 0 && history.stack[history.index] === snap) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snap);
    if (history.stack.length > MAX_HISTORY) history.stack.shift();
    history.index = history.stack.length - 1;
    persist();
    DC.store.emit();
  }

  function resetHistory() {
    history.stack = [snapshot()];
    history.index = 0;
    DC.store.emit();
  }

  function undo() {
    if (history.index <= 0) return false;
    history.index--;
    restore(history.stack[history.index]);
    DC.store.emit();
    return true;
  }

  function redo() {
    if (history.index >= history.stack.length - 1) return false;
    history.index++;
    restore(history.stack[history.index]);
    DC.store.emit();
    return true;
  }

  const listeners = [];
  DC.store = {
    canUndo: () => history.index > 0,
    canRedo: () => history.index < history.stack.length - 1,
    commit, undo, redo, resetHistory, persist, loadParams, snapshot, restore,
    emit() { listeners.forEach((fn) => fn()); },
    onChange(fn) { listeners.push(fn); },
  };

  DC.state = S;
  DC.DEFAULT_PARAMS = DEFAULT_PARAMS;
  DC.DEFAULT_PRINT = DEFAULT_PRINT;
})(window.DC);

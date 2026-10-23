/* ===============================================================
   enhance.js —— 去底 / 漂白 / 锐化（核心像素运算）

   算法要点
   --------
   纸底估计 = 灰度膨胀（跳过墨迹，取邻域最亮值）+ 盒式模糊（消除块状感）。
   单纯模糊遇到大块深色区域（粗标题、图章）会把文字一起洗白，所以必须用膨胀。
   然后 out = in × (255 / 纸底)，纸底被拉到 255，墨迹几乎不变。
   彩色模式对 R/G/B 分别估一遍，相当于自动白平衡，黄纸底才能真正变白。
   =============================================================== */
(function (DC) {
  "use strict";

  const { makeCanvas, ctx2d } = DC.utils;

  const GAIN_CAP = 2.4;      // 单像素最大增益，防止深色块被过度提亮
  const BG_SMALL = 320;      // 背景图的长边像素数
  const CACHE_LIMIT = 6;

  /* ---------- 一维滑动窗口最大值（单调递减队列，O(1)/像素） ---------- */
  function maxFilter1D(src, dst, w, h, r, horizontal) {
    const len = horizontal ? w : h;
    const outer = horizontal ? h : w;
    const dq = new Int32Array(len + 1);

    for (let o = 0; o < outer; o++) {
      const base = horizontal ? o * w : o;
      const step = horizontal ? 1 : w;
      let head = 0, tail = 0, next = 0;

      for (let i = 0; i < len; i++) {
        const hi = i + r < len ? i + r : len - 1;
        while (next <= hi) {
          const v = src[base + next * step];
          while (tail > head && src[base + dq[tail - 1] * step] <= v) tail--;
          dq[tail++] = next++;
        }
        const lo = i - r;
        while (tail > head && dq[head] < lo) head++;
        dst[base + i * step] = src[base + dq[head] * step];
      }
    }
  }

  /* ---------- 单通道纸底估计 ---------- */
  function estimateBg(src, sw, sh, r) {
    const tmp = new Float32Array(sw * sh);
    const out = new Float32Array(sw * sh);
    maxFilter1D(src, tmp, sw, sh, r, true);
    maxFilter1D(tmp, out, sw, sh, r, false);

    // 再模糊一次消除块状感（积分图，O(1)/像素）
    const rb = Math.max(1, Math.round(r * 0.5));
    const W = sw + 1;
    const integral = new Float64Array(W * (sh + 1));
    for (let y = 0; y < sh; y++) {
      let rowSum = 0;
      for (let x = 0; x < sw; x++) {
        rowSum += out[y * sw + x];
        integral[(y + 1) * W + (x + 1)] = integral[y * W + (x + 1)] + rowSum;
      }
    }
    const res = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const y0 = Math.max(0, y - rb), y1 = Math.min(sh - 1, y + rb);
      for (let x = 0; x < sw; x++) {
        const x0 = Math.max(0, x - rb), x1 = Math.min(sw - 1, x + rb);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          integral[(y1 + 1) * W + (x1 + 1)] - integral[y0 * W + (x1 + 1)] -
          integral[(y1 + 1) * W + x0] + integral[y0 * W + x0];
        res[y * sw + x] = sum / area;
      }
    }
    return res;
  }

  /* ---------- 背景图（带缓存） ---------- */
  function buildBg(canvas, rev) {
    const S = DC.state;
    const radiusPct = S.params.radius;
    const key = canvas.width + "x" + canvas.height + "@" + radiusPct + "#" + rev;

    const hit = S.bgCache.get(key);
    if (hit) return hit;

    const sc = Math.min(1, BG_SMALL / Math.max(canvas.width, canvas.height));
    const sw = Math.max(3, Math.round(canvas.width * sc));
    const sh = Math.max(3, Math.round(canvas.height * sc));

    const small = makeCanvas(sw, sh);
    const sx = ctx2d(small);
    sx.fillStyle = "#fff";
    sx.fillRect(0, 0, sw, sh);
    sx.drawImage(canvas, 0, 0, sw, sh);
    const sd = sx.getImageData(0, 0, sw, sh).data;

    const n = sw * sh;
    const lum = new Float32Array(n);
    const cr = new Float32Array(n);
    const cg = new Float32Array(n);
    const cb = new Float32Array(n);
    for (let i = 0, p = 0; p < n; p++, i += 4) {
      cr[p] = sd[i]; cg[p] = sd[i + 1]; cb[p] = sd[i + 2];
      lum[p] = 0.299 * sd[i] + 0.587 * sd[i + 1] + 0.114 * sd[i + 2];
    }

    const r = Math.max(1, Math.round(Math.min(sw, sh) * radiusPct / 100));
    const entry = {
      w: sw, h: sh,
      data: estimateBg(lum, sw, sh, r),
      ch: [
        estimateBg(cr, sw, sh, r),
        estimateBg(cg, sw, sh, r),
        estimateBg(cb, sw, sh, r),
      ],
    };

    S.bgCache.set(key, entry);
    if (S.bgCache.size > CACHE_LIMIT) {
      S.bgCache.delete(S.bgCache.keys().next().value);
    }
    return entry;
  }

  /* ---------- 锐化（3×3 拉普拉斯） ---------- */
  function sharpenCanvas(canvas, amount) {
    const w = canvas.width, h = canvas.height;
    if (w < 3 || h < 3) return;
    const cx = ctx2d(canvas);
    const img = cx.getImageData(0, 0, w, h);
    const d = img.data;
    const s = new Uint8ClampedArray(d);

    for (let y = 1; y < h - 1; y++) {
      const rowUp = (y - 1) * w * 4;
      const row = y * w * 4;
      const rowDn = (y + 1) * w * 4;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x * 4;
        for (let c = 0; c < 3; c++) {
          const v = s[i + c];
          const nb = s[i - 4 + c] + s[i + 4 + c] + s[rowUp + x * 4 + c] + s[rowDn + x * 4 + c];
          d[i + c] = v + amount * (4 * v - nb) * 0.25;
        }
      }
    }
    cx.putImageData(img, 0, 0);
  }

  /* ---------- 主处理 ----------
     返回新的 canvas，不修改入参。
     rev：内容版本号，参与背景缓存 key，避免同尺寸不同内容命中旧缓存。
  --------------------------------------------------------------- */
  function process(canvas, rev) {
    const S = DC.state;
    const P = S.params;
    const w = canvas.width, h = canvas.height;
    const srcData = ctx2d(canvas).getImageData(0, 0, w, h);
    const d = srcData.data;

    const bg = buildBg(canvas, rev == null ? S.srcRev : rev);
    const bw = bg.w, bh = bg.h, bd = bg.data;
    const sxr = bw / w, syr = bh / h;

    const isColor = P.mode === "color";
    const strength = P.strength / 100;
    const bp = P.black;
    const span = Math.max(1, P.white - P.black);
    const kf = 255 / span;
    const invert = P.invert;

    const outCanvas = makeCanvas(w, h);
    const octx = ctx2d(outCanvas);
    const outImg = octx.createImageData(w, h);
    const od = outImg.data;

    const chR = bg.ch[0], chG = bg.ch[1], chB = bg.ch[2];
    const rowA = new Float32Array(w);
    const rowR = isColor ? new Float32Array(w) : null;
    const rowG = isColor ? new Float32Array(w) : null;
    const rowB = isColor ? new Float32Array(w) : null;

    /** 把一个背景通道按行插值到目标宽度 */
    function fillRow(dst, src, y) {
      const fy = (y + 0.5) * syr - 0.5;
      let y0 = Math.floor(fy);
      let ty = fy - y0;
      if (y0 < 0) { y0 = 0; ty = 0; }
      if (y0 > bh - 1) y0 = bh - 1;
      let y1 = y0 + 1;
      if (y1 > bh - 1) y1 = bh - 1;

      const o0 = y0 * bw, o1 = y1 * bw;
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) * sxr - 0.5;
        let x0 = Math.floor(fx);
        let tx = fx - x0;
        if (x0 < 0) { x0 = 0; tx = 0; }
        if (x0 > bw - 1) x0 = bw - 1;
        let x1 = x0 + 1;
        if (x1 > bw - 1) x1 = bw - 1;

        const a = src[o0 + x0] + (src[o0 + x1] - src[o0 + x0]) * tx;
        const b = src[o1 + x0] + (src[o1 + x1] - src[o1 + x0]) * tx;
        dst[x] = a + (b - a) * ty;
      }
    }

    for (let y = 0; y < h; y++) {
      fillRow(rowA, bd, y);
      if (isColor) {
        fillRow(rowR, chR, y);
        fillRow(rowG, chG, y);
        fillRow(rowB, chB, y);
      }

      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], bl = d[i + 2];

        if (isColor) {
          let fr = 255 / Math.max(12, Math.min(255, rowR[x]));
          let fg = 255 / Math.max(12, Math.min(255, rowG[x]));
          let fb = 255 / Math.max(12, Math.min(255, rowB[x]));
          if (fr > GAIN_CAP) fr = GAIN_CAP;
          if (fg > GAIN_CAP) fg = GAIN_CAP;
          if (fb > GAIN_CAP) fb = GAIN_CAP;
          fr = 1 + (fr - 1) * strength;
          fg = 1 + (fg - 1) * strength;
          fb = 1 + (fb - 1) * strength;

          let rr = r * fr, gg = g * fg, bb = bl * fb;
          const lum = 0.299 * rr + 0.587 * gg + 0.114 * bb;
          let t = (lum - bp) * kf;
          t = t < 0 ? 0 : t > 255 ? 255 : t;
          const ratio = lum > 0.5 ? t / lum : 0;
          rr *= ratio; gg *= ratio; bb *= ratio;
          if (invert) { rr = 255 - rr; gg = 255 - gg; bb = 255 - bb; }

          od[i] = rr; od[i + 1] = gg; od[i + 2] = bb; od[i + 3] = 255;
        } else {
          let bgv = rowA[x];
          if (bgv < 12) bgv = 12;
          let f = 255 / bgv;
          if (f > GAIN_CAP) f = GAIN_CAP;
          f = 1 + (f - 1) * strength;

          let t = (0.299 * r + 0.587 * g + 0.114 * bl) * f;
          t = (t - bp) * kf;
          t = t < 0 ? 0 : t > 255 ? 255 : t;
          if (invert) t = 255 - t;

          od[i] = od[i + 1] = od[i + 2] = t;
          od[i + 3] = 255;
        }
      }
    }

    octx.putImageData(outImg, 0, 0);

    const amt = (P.sharpen / 100) * 0.9;
    if (amt > 0.01) sharpenCanvas(outCanvas, amt);

    return outCanvas;
  }

  DC.enhance = { process, buildBg, estimateBg, maxFilter1D, sharpenCanvas };
})(window.DC);

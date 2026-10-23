/* ===============================================================
   geometry.js —— 几何预处理：旋转、倾斜检测、画布构建
   =============================================================== */
(function (DC) {
  "use strict";

  const { makeCanvas, ctx2d, clamp } = DC.utils;
  const S = () => DC.state;

  /* ---------------------------------------------------------------
     旋转补边的“纸色”
     用纯白补边会被去底算法当成纸底，导致图片边缘留一圈灰。
     先量出原图 75 分位亮度当纸色，旋转后再由去底算法统一洗白。
     --------------------------------------------------------------- */
  function paperFill() {
    const s = S();
    if (s.paperFill) return s.paperFill;
    if (!s.img) return "#ffffff";

    const n = 64;
    const small = makeCanvas(n, n);
    const cx = ctx2d(small);
    cx.drawImage(s.img, 0, 0, n, n);
    const d = cx.getImageData(0, 0, n, n).data;

    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
    }
    let acc = 0;
    const target = n * n * 0.75;
    let v = 255;
    for (let k = 0; k < 256; k++) {
      acc += hist[k];
      if (acc >= target) { v = k; break; }
    }
    // 亮度够高才视为“纸质图”；普通照片用白边更自然
    const g = v >= 175 ? Math.min(255, Math.max(200, v)) : 255;
    s.paperFill = "rgb(" + g + "," + g + "," + g + ")";
    return s.paperFill;
  }

  /* ---------------------------------------------------------------
     生成 base：旋转（含微调角度）后的整图，不做裁剪。
     透视裁剪在 perspective.js 里对 base 做单应变换。
     --------------------------------------------------------------- */
  function buildBase(maxDim) {
    const s = S();
    if (!s.img) return null;

    const deg = s.rotation + s.angle;
    const rad = (deg * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const sn = Math.abs(Math.sin(rad));
    const bw = s.srcW * c + s.srcH * sn;
    const bh = s.srcW * sn + s.srcH * c;

    let scale = 1;
    if (maxDim && Math.max(bw, bh) > maxDim) scale = maxDim / Math.max(bw, bh);

    const canvas = makeCanvas(bw * scale, bh * scale);
    const cx = ctx2d(canvas, { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.fillStyle = paperFill();
    cx.fillRect(0, 0, canvas.width, canvas.height);
    cx.translate(canvas.width / 2, canvas.height / 2);
    cx.rotate(rad);
    cx.scale(scale, scale);
    cx.drawImage(s.img, -s.srcW / 2, -s.srcH / 2);

    return canvas;
  }

  /** base（未裁剪）的尺寸，用于导出信息展示 */
  function baseSize() {
    const s = S();
    const deg = s.rotation + s.angle;
    const rad = (deg * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const sn = Math.abs(Math.sin(rad));
    return {
      w: s.srcW * c + s.srcH * sn,
      h: s.srcW * sn + s.srcH * c,
    };
  }

  /* ---------------------------------------------------------------
     自动纠正倾斜
     思路：Otsu 取墨点 → 逐角度做水平投影 → 投影平方和最大者即文字行方向。
     关键：必须“软分箱”（相邻两个 bin 线性分配），否则整角度落格更整齐，
     打分会被虚假地拉向 0°。
     --------------------------------------------------------------- */
  function autoDeskew() {
    const s = S();
    if (!s.img) return null;

    const MAX = 900;
    const sc = Math.min(1, MAX / Math.max(s.srcW, s.srcH));
    const w = Math.max(8, Math.round(s.srcW * sc));
    const h = Math.max(8, Math.round(s.srcH * sc));

    const canvas = makeCanvas(w, h);
    const cx = ctx2d(canvas);
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, w, h);
    cx.drawImage(s.img, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;

    /* --- Otsu 阈值 --- */
    const hist = new Array(256).fill(0);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
    }
    const total = w * h;
    let sumAll = 0;
    for (let v = 0; v < 256; v++) sumAll += v * hist[v];

    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = v; }
    }

    /* --- 收集墨点 --- */
    const pts = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < thr) {
          pts.push(x, y);
        }
      }
    }
    if (pts.length < 400) return { angle: null, reason: "empty" };

    /* --- 逐角度打分 --- */
    const maxTan = Math.tan((12 * Math.PI) / 180);
    const offset = Math.ceil(w * maxTan) + 4;
    const bins = h + offset * 2;
    const histArr = new Float64Array(bins);

    function scoreAt(deg) {
      const tan = Math.tan((deg * Math.PI) / 180);
      histArr.fill(0);
      for (let i = 0; i < pts.length; i += 2) {
        const pos = pts[i + 1] - pts[i] * tan + offset;
        const b0 = Math.floor(pos);
        if (b0 < 0 || b0 >= bins - 1) continue;
        const fr = pos - b0;
        histArr[b0] += 1 - fr;
        histArr[b0 + 1] += fr;
      }
      let score = 0;
      for (let i = 0; i < bins; i++) score += histArr[i] * histArr[i];
      return score;
    }

    let bestT = 0, bestScore = -1;
    for (let t10 = -120; t10 <= 120; t10 += 5) {
      const sc2 = scoreAt(t10 / 10);
      if (sc2 > bestScore) { bestScore = sc2; bestT = t10 / 10; }
    }
    let refined = bestT, bestScore2 = -1;
    for (let k = -4; k <= 4; k++) {
      const t = bestT + k * 0.25;
      const sc2 = scoreAt(t);
      if (sc2 > bestScore2) { bestScore2 = sc2; refined = t; }
    }

    return { angle: clamp(-refined, -15, 15) };
  }

  DC.geometry = { buildBase, baseSize, paperFill, autoDeskew };
})(window.DC);

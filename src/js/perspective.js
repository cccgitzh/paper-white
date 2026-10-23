/* ===============================================================
   perspective.js —— 透视裁剪的数学与几何约束

   数据模型：quad = [TL, TR, BR, BL]，每点为归一化坐标 {x,y} ∈ [0,1]，
   坐标系是「旋转后的整图」（也就是 geometry.buildBase 的结果）。

   裁剪 = 求单应矩阵 H，使目标矩形四角映射到 quad 四角，
   再对目标逐像素反查源图（双线性采样）——
   这样倾斜拍摄的文档，四条纸边会被真正拉直，而不只是裁掉。
   =============================================================== */
(function (DC) {
  "use strict";

  const { makeCanvas, ctx2d, clamp } = DC.utils;

  const MIN_EDGE_RATIO = 0.015;  // 最短边 ≥ 对角线 1.5%，防止退化成线
  const RECT_TOL = 0.6;          // 轴对齐矩形判定容差（源图像素）

  /* ---------- 基础 ---------- */
  function defaultQuad() {
    return [
      { x: 0.02, y: 0.02 },
      { x: 0.98, y: 0.02 },
      { x: 0.98, y: 0.98 },
      { x: 0.02, y: 0.98 },
    ];
  }

  function cloneQuad(q) {
    return q.map((p) => ({ x: p.x, y: p.y }));
  }

  function quadToPx(quad, w, h) {
    return quad.map((p) => ({ x: p.x * w, y: p.y * h }));
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /* ---------- 输出尺寸：取对边平均，减少梯形拉伸 ---------- */
  function metrics(base, quad) {
    const w = base.width, h = base.height;
    const p = quadToPx(quad, w, h);
    const wTop = dist(p[0], p[1]);
    const wBot = dist(p[3], p[2]);
    const hL = dist(p[0], p[3]);
    const hR = dist(p[1], p[2]);
    return {
      outW: Math.max(1, Math.round((wTop + wBot) / 2)),
      outH: Math.max(1, Math.round((hL + hR) / 2)),
      px: p,
    };
  }

  /* ---------- 凸性判定（四条边叉积同号） ---------- */
  function isConvex(quad) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const c = quad[(i + 2) % 4];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) < 1e-9) return false;
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  /* ---------- 合法性：在界内 + 凸 + 边够长 ---------- */
  function isValidQuad(quad, baseW, baseH) {
    for (const p of quad) {
      if (!(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return false;
    }
    if (!isConvex(quad)) return false;

    const diag = Math.hypot(baseW, baseH);
    const minEdge = diag * MIN_EDGE_RATIO;
    for (let i = 0; i < 4; i++) {
      const a = { x: quad[i].x * baseW, y: quad[i].y * baseH };
      const b = { x: quad[(i + 1) % 4].x * baseW, y: quad[(i + 1) % 4].y * baseH };
      if (dist(a, b) < minEdge) return false;
    }
    return true;
  }

  /* ---------- 拖拽：单角 ---------- */
  function moveCorner(quad, idx, nx, ny, baseW, baseH) {
    const q = cloneQuad(quad);
    q[idx] = { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
    return isValidQuad(q, baseW, baseH) ? q : null;
  }

  /* ---------- 拖拽：整条边（两端同步位移） ---------- */
  function moveEdge(quad, idx, dx, dy, baseW, baseH) {
    const q = cloneQuad(quad);
    const j = (idx + 1) % 4;
    q[idx] = { x: clamp(q[idx].x + dx, 0, 1), y: clamp(q[idx].y + dy, 0, 1) };
    q[j] = { x: clamp(q[j].x + dx, 0, 1), y: clamp(q[j].y + dy, 0, 1) };
    return isValidQuad(q, baseW, baseH) ? q : null;
  }

  /* ---------- 拖拽：整体平移（碰到边界整体停住，不变形） ---------- */
  function moveQuad(quad, dx, dy) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of quad) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const ddx = clamp(dx, -minX, 1 - maxX);
    const ddy = clamp(dy, -minY, 1 - maxY);
    return quad.map((p) => ({ x: p.x + ddx, y: p.y + ddy }));
  }

  /* ---------- 8×8 线性方程组（高斯消元，列主元） ---------- */
  function solveLinear(A, b) {
    const n = b.length;
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      }
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      if (piv !== col) {
        const t = A[piv]; A[piv] = A[col]; A[col] = t;
        const tb = b[piv]; b[piv] = b[col]; b[col] = tb;
      }
      const pv = A[col][col];
      for (let r = col + 1; r < n; r++) {
        const f = A[r][col] / pv;
        if (!f) continue;
        for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
        b[r] -= f * b[col];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
      x[r] = s / A[r][r];
    }
    return x;
  }

  /** 求单应矩阵 H，使 to[i] = H(from[i])；返回 [a,b,c,d,e,f,g,h] */
  function homography(from, to) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = from[i];
      const { x: u, y: v } = to[i];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    return solveLinear(A, b);
  }

  /* ---------- 判断是否轴对齐矩形（可走 drawImage 快路径） ---------- */
  function isAxisRect(px) {
    return (
      Math.abs(px[0].y - px[1].y) < RECT_TOL &&
      Math.abs(px[3].y - px[2].y) < RECT_TOL &&
      Math.abs(px[0].x - px[3].x) < RECT_TOL &&
      Math.abs(px[1].x - px[2].x) < RECT_TOL
    );
  }

  /* ---------- 透视变换 ---------- */
  function warp(base, quad) {
    const W = base.width, H = base.height;
    const m = metrics(base, quad);
    const px = m.px;
    const outW = m.outW, outH = m.outH;

    const out = makeCanvas(outW, outH);
    const octx = ctx2d(out);

    /* 快路径：本来就是正矩形，直接裁切，省一次重采样 */
    if (isAxisRect(px)) {
      const x0 = Math.round(Math.min(px[0].x, px[3].x));
      const y0 = Math.round(Math.min(px[0].y, px[1].y));
      const x1 = Math.round(Math.max(px[1].x, px[2].x));
      const y1 = Math.round(Math.max(px[2].y, px[3].y));
      octx.fillStyle = "#fff";
      octx.fillRect(0, 0, outW, outH);
      octx.drawImage(base, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0), 0, 0, outW, outH);
      return out;
    }

    /* 反查表：目标矩形 → 源四边形 */
    const h = homography(
      [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }],
      px
    );
    if (!h) {
      octx.fillStyle = "#fff";
      octx.fillRect(0, 0, outW, outH);
      return out;
    }

    const srcData = ctx2d(base).getImageData(0, 0, W, H).data;
    const outImg = octx.createImageData(outW, outH);
    const od = outImg.data;

    const a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    const maxX = W - 1, maxY = H - 1;

    for (let y = 0; y < outH; y++) {
      const y0 = y + 0.5;
      let oi = y * outW * 4;
      for (let x = 0; x < outW; x++, oi += 4) {
        const x0 = x + 0.5;
        const den = g * x0 + k * y0 + 1;
        let sx, sy;
        if (den === 0) { sx = 0; sy = 0; }
        else {
          sx = (a * x0 + b * y0 + c) / den - 0.5;
          sy = (d * x0 + e * y0 + f) / den - 0.5;
        }

        /* 双线性采样（边界钳制，避免黑边） */
        if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;

        const ix = sx | 0, iy = sy | 0;
        const fx = sx - ix, fy = sy - iy;
        const ix1 = ix + 1 > maxX ? maxX : ix + 1;
        const iy1 = iy + 1 > maxY ? maxY : iy + 1;

        const p00 = (iy * W + ix) * 4;
        const p10 = (iy * W + ix1) * 4;
        const p01 = (iy1 * W + ix) * 4;
        const p11 = (iy1 * W + ix1) * 4;

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        od[oi] = srcData[p00] * w00 + srcData[p10] * w10 + srcData[p01] * w01 + srcData[p11] * w11;
        od[oi + 1] = srcData[p00 + 1] * w00 + srcData[p10 + 1] * w10 + srcData[p01 + 1] * w01 + srcData[p11 + 1] * w11;
        od[oi + 2] = srcData[p00 + 2] * w00 + srcData[p10 + 2] * w10 + srcData[p01 + 2] * w01 + srcData[p11 + 2] * w11;
        od[oi + 3] = 255;
      }
    }

    octx.putImageData(outImg, 0, 0);
    return out;
  }

  DC.perspective = {
    defaultQuad, cloneQuad, quadToPx, metrics, isConvex, isValidQuad,
    moveCorner, moveEdge, moveQuad, homography, warp, MIN_EDGE_RATIO,
  };
})(window.DC);

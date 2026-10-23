/* ===============================================================
   app.js —— 装配层：渲染管线、文件载入、控件绑定、快捷键
   =============================================================== */
(function (DC) {
  "use strict";

  const { $, $$, clamp, makeCanvas, ctx2d, toast, fmtMs, safeName, download } = DC.utils;
  const S = DC.state;

  const PREVIEW_MAX = 1200;
  const FORMATS = {
    png: { mime: "image/png", ext: "png" },
    jpeg: { mime: "image/jpeg", ext: "jpg" },
    webp: { mime: "image/webp", ext: "webp" },
  };

  /* ================= 渲染管线 ================= */

  function paint(canvas) {
    const pv = $("preview");
    pv.width = canvas.width;
    pv.height = canvas.height;
    const cx = ctx2d(pv);
    cx.clearRect(0, 0, pv.width, pv.height);
    cx.drawImage(canvas, 0, 0);
    pv.hidden = false;
    $("empty").hidden = true;
  }

  /** 裁剪编辑态：主画布直接显示未处理的旋转整图 */
  function paintRaw(base) {
    paint(base);
  }

  function render() {
    if (!S.img || S.cropMode) return;
    const t0 = performance.now();

    const base = DC.geometry.buildBase(PREVIEW_MAX);
    const warped = S.quad ? DC.perspective.warp(base, S.quad) : base;
    const out = DC.enhance.process(warped, S.srcRev);

    paint(out);

    S.outW = out.width;
    S.outH = out.height;
    S.lastRenderMs = performance.now() - t0;

    updateOutSize();
    updateStatus();
  }

  let renderRaf = 0;
  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = 0;
      render();
    });
  }

  /** 导出尺寸（全分辨率下计算，与预览无关） */
  function exportSize() {
    const b = DC.geometry.baseSize();
    if (!S.quad) return { w: Math.round(b.w), h: Math.round(b.h) };
    const m = DC.perspective.metrics({ width: b.w, height: b.h }, S.quad);
    return { w: m.outW, h: m.outH };
  }

  function updateOutSize() {
    const s = exportSize();
    $("outSize").textContent = s.w + " × " + s.h + " px";
  }

  /* ================= 状态栏 / 忙碌 / 提示 ================= */

  function updateStatus() {
    const bar = $("statusbar");
    if (!S.img) { bar.classList.remove("show"); return; }
    bar.classList.add("show");
    $("stName").textContent = S.name;
    $("stSize").textContent = S.outW + " × " + S.outH + " px";
    $("stTime").textContent = S.cropMode ? "裁剪中" : fmtMs(S.lastRenderMs);
    $("stMode").textContent = S.params.mode === "gray" ? "黑白文档" : "保留彩色";
  }

  function setBusy(on, text) {
    S.busy = on;
    $("busy").classList.toggle("show", on);
    if (text) $("busyText").textContent = text;
  }

  /* ================= 文件载入 ================= */

  function applySource(canvas, name, meta) {
    S.img = canvas;
    S.srcW = canvas.width;
    S.srcH = canvas.height;
    S.name = name || "image";
    S.meta = meta || "";
    S.paperFill = null;
    S.rotation = 0;
    S.angle = 0;
    S.quad = null;
    S.srcRev++;
    S.bgCache.clear();

    syncControls();
    render();
    DC.store.resetHistory();
  }

  async function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast("请选择图片文件", "err");
      return;
    }
    setBusy(true, "正在读取图片…");
    try {
      let bmp;
      try {
        bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (e) {
        bmp = await createImageBitmap(file);
      }
      const c = makeCanvas(bmp.width, bmp.height);
      c.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();

      applySource(c, file.name.replace(/\.[^.]+$/, "") || "image",
        DC.utils.fmtBytes(file.size));
      toast("已载入 " + file.name, "ok");
    } catch (err) {
      toast("读取失败：" + err.message, "err");
    } finally {
      setBusy(false);
    }
  }

  /* ================= 导出 ================= */

  function exportImage() {
    if (!S.img) return;
    const fmt = FORMATS[S.params.format] ? S.params.format : "png";
    setBusy(true, "正在导出原图…");

    setTimeout(() => {
      try {
        const base = DC.geometry.buildBase(null);
        const warped = S.quad ? DC.perspective.warp(base, S.quad) : base;
        const out = DC.enhance.process(warped, S.srcRev + "-export");

        const mime = FORMATS[fmt].mime;
        const quality = fmt === "png" ? undefined : S.params.quality / 100;

        out.toBlob((blob) => {
          if (!blob) {
            // 个别浏览器不支持 webp 编码时回退
            out.toBlob((b2) => {
              setBusy(false);
              if (!b2) { toast("导出失败：浏览器不支持该格式", "err"); return; }
              download(b2, safeName(S.name) + "_去底.png");
              toast("已导出 PNG", "ok");
            }, "image/png");
            return;
          }
          setBusy(false);
          download(blob, safeName(S.name) + "_去底." + FORMATS[fmt].ext);
          toast("已导出 " + S.params.format.toUpperCase() + " · " + DC.utils.fmtBytes(blob.size), "ok");
        }, mime, quality);
      } catch (e) {
        setBusy(false);
        toast("导出失败：" + e.message, "err");
      }
    }, 30);
  }

  /* ================= 控件同步 ================= */

  function syncControls() {
    const P = S.params;

    setSlider("strength", P.strength);
    setSlider("radius", P.radius);
    setSlider("black", P.black);
    setSlider("white", P.white);
    setSlider("sharpen", P.sharpen);
    setSlider("angle", S.angle, S.angle.toFixed(1) + "°");

    $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === P.mode));
    $$("#fmtSeg button").forEach((b) => b.classList.toggle("on", b.dataset.fmt === P.format));

    $("invert").classList.toggle("on", !!P.invert);
    $("invert").setAttribute("aria-checked", String(!!P.invert));

    $("qualityRow").hidden = P.format === "png";
    $("quality").value = P.quality;
    $("vQuality").textContent = P.quality;

    $("btnClearCrop").disabled = !S.quad;
    $("btnSave").disabled = !S.img;
    $("btnPrint").disabled = !S.img;

    // 裁剪按钮文案随状态变化
    $("btnCrop").textContent = S.cropMode ? "退出裁剪" : (S.quad ? "调整裁剪" : "透视裁剪");
  }

  function setSlider(id, value, label) {
    const el = $(id);
    if (!el) return;
    el.value = value;
    const out = $("v" + id.charAt(0).toUpperCase() + id.slice(1));
    if (out) out.textContent = label != null ? label : value;
  }

  function updateHistoryButtons() {
    $("btnUndo").disabled = !DC.store.canUndo();
    $("btnRedo").disabled = !DC.store.canRedo();
  }

  /* ================= 参数变更入口 ================= */

  /** 几何变化（旋转/角度）会让裁剪框失效，一并清掉 */
  function invalidateCrop() {
    if (S.quad) {
      S.quad = null;
      toast("几何变化已重置裁剪框");
    }
  }

  function afterParamChange(commit) {
    S.srcRev++;
    scheduleRender();
    if (commit) DC.store.commit();
  }

  /* ================= 示例图 ================= */

  /* 3×3 矩阵求逆（行主序 9 元素） */
  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const id = 1 / det;
    return [
      A * id, -(b * i - c * h) * id, (b * f - c * e) * id,
      B * id, (a * i - c * g) * id, -(a * f - c * d) * id,
      C * id, -(a * h - b * g) * id, (a * e - b * d) * id,
    ];
  }

  /**
   * 把 src 画布按透视贴到 dst 上（逐像素反查 + 双线性 + 边缘羽化）。
   * 用两个三角形做仿射近似会在对角线上留下接缝，所以这里老老实实算单应反变换。
   */
  function rasterQuad(dstCtx, src, quad, dstW, dstH) {
    const sw = src.width, sh = src.height;

    const srcQuad = [
      { x: 0, y: 0 }, { x: sw, y: 0 }, { x: sw, y: sh }, { x: 0, y: sh },
    ];
    const h = DC.perspective.homography(srcQuad, quad);
    if (!h) return;
    const inv = invert3([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
    if (!inv) return;

    const sd = ctx2d(src).getImageData(0, 0, sw, sh).data;
    const dstImg = dstCtx.getImageData(0, 0, dstW, dstH);
    const dd = dstImg.data;

    // 只遍历四边形包围盒
    let minX = dstW, minY = dstH, maxX = 0, maxY = 0;
    for (const p of quad) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    minX = Math.max(0, Math.floor(minX)); maxX = Math.min(dstW - 1, Math.ceil(maxX));
    minY = Math.max(0, Math.floor(minY)); maxY = Math.min(dstH - 1, Math.ceil(maxY));

    const FEATHER = 1.2;
    const maxSU = sw - 1, maxSV = sh - 1;

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      let oi = (y * dstW + minX) * 4;
      for (let x = minX; x <= maxX; x++, oi += 4) {
        const px = x + 0.5;

        const wgt = inv[6] * px + inv[7] * py + inv[8];
        if (Math.abs(wgt) < 1e-9) continue;
        const u = (inv[0] * px + inv[1] * py + inv[2]) / wgt - 0.5;
        const v = (inv[3] * px + inv[4] * py + inv[5]) / wgt - 0.5;

        if (u < -FEATHER || v < -FEATHER || u > maxSU + FEATHER || v > maxSV + FEATHER) continue;

        // 边缘羽化，避免锯齿硬边
        let a = 1;
        if (u < FEATHER) a = Math.min(a, Math.max(0, (u + FEATHER) / (2 * FEATHER)));
        if (u > maxSU - FEATHER) a = Math.min(a, Math.max(0, (maxSU + FEATHER - u) / (2 * FEATHER)));
        if (v < FEATHER) a = Math.min(a, Math.max(0, (v + FEATHER) / (2 * FEATHER)));
        if (v > maxSV - FEATHER) a = Math.min(a, Math.max(0, (maxSV + FEATHER - v) / (2 * FEATHER)));
        if (a <= 0) continue;

        const cu = u < 0 ? 0 : u > maxSU ? maxSU : u;
        const cv = v < 0 ? 0 : v > maxSV ? maxSV : v;
        const iu = cu | 0, iv = cv | 0;
        const fu = cu - iu, fv = cv - iv;
        const iu1 = iu + 1 > maxSU ? maxSU : iu + 1;
        const iv1 = iv + 1 > maxSV ? maxSV : iv + 1;

        const p00 = (iv * sw + iu) * 4;
        const p10 = (iv * sw + iu1) * 4;
        const p01 = (iv1 * sw + iu) * 4;
        const p11 = (iv1 * sw + iu1) * 4;

        const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv);
        const w01 = (1 - fu) * fv, w11 = fu * fv;

        for (let ch = 0; ch < 3; ch++) {
          const val =
            sd[p00 + ch] * w00 + sd[p10 + ch] * w10 +
            sd[p01 + ch] * w01 + sd[p11 + ch] * w11;
          dd[oi + ch] = a * val + (1 - a) * dd[oi + ch];
        }
      }
    }

    dstCtx.putImageData(dstImg, 0, 0);
  }

  function makeSample() {
    /* 1) 先画一张“纸上文字” */
    const dw = 900, dh = 1240;
    const paper = makeCanvas(dw, dh);
    const px = ctx2d(paper);

    const grd = px.createLinearGradient(0, 0, dw, dh);
    grd.addColorStop(0, "#efeade");
    grd.addColorStop(0.5, "#e3dccb");
    grd.addColorStop(1, "#f1ecdf");
    px.fillStyle = grd;
    px.fillRect(0, 0, dw, dh);

    const nd = px.getImageData(0, 0, dw, dh);
    for (let i = 0; i < nd.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 14;
      nd.data[i] += n; nd.data[i + 1] += n; nd.data[i + 2] += n;
    }
    px.putImageData(nd, 0, 0);

    px.fillStyle = "#2b2723";
    px.textAlign = "center";
    px.font = "600 42px 'PingFang SC','Microsoft YaHei',serif";
    px.fillText("关于图片去底与漂白的说明", dw / 2, 132);

    px.textAlign = "left";
    px.font = "21px 'PingFang SC','Microsoft YaHei',serif";
    const lines = [
      "很多扫描件或翻拍件看起来发灰、发黄，",
      "原因是纸底不是纯白，且光照不均匀。",
      "去底的思路是：先估计每一处纸底的亮度，",
      "再用像素值除以这个估计值并拉伸到 255。",
      "这样纸底被拉成纯白，而墨迹几乎不变，",
      "文字边缘的过渡也会被保留下来。",
      "斜着拍的照片，还需要做透视裁剪，",
      "把四条纸边拉直成矩形。"
    ];
    let yy = 240;
    for (const ln of lines) {
      px.fillStyle = "#332e28";
      px.fillText(ln, 100, yy);
      yy += 58;
    }
    px.fillStyle = "#c9bfa8";
    px.fillRect(100, yy + 16, 700, 2);
    px.fillStyle = "#3a342d";
    px.font = "18px 'PingFang SC','Microsoft YaHei',serif";
    px.fillText("示例图：模拟一张斜拍的文档照片，可直接试用透视裁剪。", 100, yy + 62);

    /* 2) 放到“桌面”上，带一点透视 */
    const W = 1200, H = 1600;
    const c = makeCanvas(W, H);
    const cx = ctx2d(c);

    const desk = cx.createLinearGradient(0, 0, W, H);
    desk.addColorStop(0, "#6b6a66");
    desk.addColorStop(0.45, "#565553");
    desk.addColorStop(1, "#3f3f3e");
    cx.fillStyle = desk;
    cx.fillRect(0, 0, W, H);

    // 桌面纹理
    cx.save();
    cx.globalAlpha = 0.06;
    cx.strokeStyle = "#fff";
    cx.lineWidth = 1;
    for (let i = 0; i < 900; i++) {
      const y = Math.random() * H;
      cx.beginPath();
      cx.moveTo(0, y);
      cx.lineTo(W, y + (Math.random() - 0.5) * 26);
      cx.stroke();
    }
    cx.restore();

    const quad = [
      { x: 236, y: 214 },   // TL
      { x: 1002, y: 292 },  // TR
      { x: 1064, y: 1418 }, // BR
      { x: 150, y: 1322 },  // BL
    ];

    // 阴影
    cx.save();
    cx.beginPath();
    cx.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < 4; i++) cx.lineTo(quad[i].x, quad[i].y);
    cx.closePath();
    cx.shadowColor = "rgba(0,0,0,.55)";
    cx.shadowBlur = 42;
    cx.shadowOffsetY = 16;
    cx.fillStyle = "#222";
    cx.fill();
    cx.restore();

    rasterQuad(cx, paper, quad, W, H);

    // 一点光照不均
    const light = cx.createRadialGradient(W * 0.3, H * 0.2, 80, W * 0.5, H * 0.5, W * 1.1);
    light.addColorStop(0, "rgba(255,250,235,.22)");
    light.addColorStop(1, "rgba(0,0,0,.24)");
    cx.fillStyle = light;
    cx.fillRect(0, 0, W, H);

    applySource(c, "示例文档照片", "示例 · 1200×1600");
    toast("这是斜拍的文档照片，试试右下角的「透视裁剪」", "ok", 3200);
  }

  /* ================= 事件绑定 ================= */

  function bindSlider(id, apply) {
    const el = $(id);
    el.addEventListener("input", () => {
      apply(parseFloat(el.value));
    });
  }

  function initControls() {
    /* --- 去底 / 漂白参数 --- */
    bindSlider("strength", (v) => {
      S.params.strength = v;
      $("vStrength").textContent = v;
      afterParamChange(false);
    });
    bindSlider("radius", (v) => {
      S.params.radius = v;
      $("vRadius").textContent = v;
      afterParamChange(false);
    });
    bindSlider("black", (v) => {
      S.params.black = v;
      $("vBlack").textContent = v;
      afterParamChange(false);
    });
    bindSlider("white", (v) => {
      S.params.white = v;
      $("vWhite").textContent = v;
      afterParamChange(false);
    });
    bindSlider("sharpen", (v) => {
      S.params.sharpen = v;
      $("vSharpen").textContent = v;
      afterParamChange(false);
    });
    bindSlider("quality", (v) => {
      S.params.quality = v;
      $("vQuality").textContent = v;
      DC.store.persist();
    });

    ["strength", "radius", "black", "white", "sharpen"].forEach((id) => {
      $(id).addEventListener("change", () => DC.store.commit());
    });

    /* --- 模式 --- */
    $("modeSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (!b || b.classList.contains("on")) return;
      S.params.mode = b.dataset.mode;
      $$("#modeSeg button").forEach((x) => x.classList.toggle("on", x === b));
      afterParamChange(true);
      updateStatus();
    });

    /* --- 格式 --- */
    $("fmtSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-fmt]");
      if (!b || b.classList.contains("on")) return;
      S.params.format = b.dataset.fmt;
      $$("#fmtSeg button").forEach((x) => x.classList.toggle("on", x === b));
      $("qualityRow").hidden = S.params.format === "png";
      DC.store.persist();
    });

    /* --- 反相 --- */
    $("invert").addEventListener("click", () => {
      S.params.invert = !S.params.invert;
      $("invert").classList.toggle("on", S.params.invert);
      $("invert").setAttribute("aria-checked", String(S.params.invert));
      afterParamChange(true);
    });

    /* --- 角度 / 旋转 --- */
    $("angle").addEventListener("input", (e) => {
      S.angle = parseFloat(e.target.value);
      $("vAngle").textContent = S.angle.toFixed(1) + "°";
      invalidateCrop();
      afterParamChange(false);
      syncControls();
    });
    $("angle").addEventListener("change", () => DC.store.commit());

    $("btnRotL").addEventListener("click", () => rotate(-90));
    $("btnRotR").addEventListener("click", () => rotate(90));

    function rotate(delta) {
      if (!S.img) return;
      if (S.cropMode) DC.crop.cancel();
      S.rotation = (S.rotation + delta + 360) % 360;
      invalidateCrop();
      S.srcRev++;
      render();
      DC.store.commit();
    }

    /* --- 自动纠正倾斜 --- */
    $("btnDeskew").addEventListener("click", () => {
      if (!S.img) return;
      setBusy(true, "正在分析倾斜角度…");
      setTimeout(() => {
        try {
          const r = DC.geometry.autoDeskew();
          if (!r || r.angle == null) {
            toast("图像中可识别的深色内容太少，请手动微调角度", "err");
            return;
          }
          if (S.cropMode) DC.crop.cancel();
          S.angle = r.angle;
          $("angle").value = S.angle.toFixed(1);
          $("vAngle").textContent = S.angle.toFixed(1) + "°";
          invalidateCrop();
          S.srcRev++;
          render();
          DC.store.commit();
          toast("已纠正 " + S.angle.toFixed(1) + "°", "ok");
        } catch (e) {
          toast("自动纠正失败：" + e.message, "err");
        } finally {
          setBusy(false);
        }
      }, 20);
    });

    /* --- 裁剪 --- */
    $("btnCrop").addEventListener("click", () => {
      if (!S.img) return;
      if (S.cropMode) DC.crop.apply();
      else DC.crop.enter();
      syncControls();
    });

    $("btnClearCrop").addEventListener("click", () => {
      if (!S.quad) return;
      S.quad = null;
      S.srcRev++;
      render();
      syncControls();
      DC.store.commit();
      toast("已取消裁剪");
    });

    /* --- 重置 --- */
    $("btnReset").addEventListener("click", () => {
      if (!S.img) return;
      if (S.cropMode) DC.crop.cancel();
      S.params = Object.assign({}, DC.DEFAULT_PARAMS, {
        format: S.params.format,
        quality: S.params.quality,
      });
      S.rotation = 0;
      S.angle = 0;
      S.quad = null;
      S.srcRev++;
      syncControls();
      render();
      updateStatus();
      DC.store.commit();
      toast("已重置参数");
    });

    /* --- 撤销 / 重做 --- */
    $("btnUndo").addEventListener("click", () => {
      if (S.cropMode) DC.crop.cancel();
      if (!DC.store.undo()) return;
      S.srcRev++;
      syncControls();
      render();
      updateStatus();
    });
    $("btnRedo").addEventListener("click", () => {
      if (S.cropMode) DC.crop.cancel();
      if (!DC.store.redo()) return;
      S.srcRev++;
      syncControls();
      render();
      updateStatus();
    });

    DC.store.onChange(updateHistoryButtons);

    /* --- 保存 / 打印 --- */
    $("btnSave").addEventListener("click", exportImage);
    $("btnSavePanel").addEventListener("click", exportImage);

    /* --- 打开文件 --- */
    const openPicker = () => $("file").click();
    $("btnOpen").addEventListener("click", openPicker);
    $("btnPick").addEventListener("click", openPicker);
    $("btnSample").addEventListener("click", makeSample);

    $("file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) loadFile(f);
      e.target.value = "";
    });

    /* --- 拖拽 / 粘贴 --- */
    const stage = $("stage");
    let dragDepth = 0;

    stage.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      stage.classList.add("dragover");
    });
    stage.addEventListener("dragover", (e) => e.preventDefault());
    stage.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) stage.classList.remove("dragover");
    });
    stage.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      stage.classList.remove("dragover");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    window.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.indexOf("image") === 0) {
          loadFile(it.getAsFile());
          break;
        }
      }
    });

    /* --- 快捷键 --- */
    window.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      const typing = /INPUT|SELECT|TEXTAREA/.test(tag);

      if (e.key === "Escape") {
        if (DC.printer.isOpen()) { DC.printer.close(); e.preventDefault(); return; }
        if (S.cropMode) { DC.crop.cancel(); syncControls(); e.preventDefault(); }
        return;
      }

      if (e.key === "Enter" && S.cropMode) {
        DC.crop.apply();
        syncControls();
        e.preventDefault();
        return;
      }

      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) $("btnRedo").click(); else $("btnUndo").click();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        $("btnRedo").click();
        return;
      }
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openPicker();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        exportImage();
        return;
      }
      if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        DC.printer.open();
        return;
      }
      if (S.cropMode && (e.key === "r" || e.key === "R")) {
        DC.crop.reset();
      }
    });

    window.addEventListener("resize", () => {
      DC.crop.onResize();
    });
  }

  /* ================= 启动 ================= */

  function boot() {
    DC.store.loadParams();
    syncControls();
    DC.crop.init();
    DC.printer.init();
    initControls();
    updateHistoryButtons();
    DC.store.resetHistory();
    updateStatus();

    // 没有图片时禁用会误触的控件
    $("btnSave").disabled = true;
    $("btnPrint").disabled = true;

    document.body.classList.remove("loading");
  }

  DC.app = {
    PREVIEW_MAX, render, scheduleRender, paintRaw, paint,
    setBusy, updateStatus, toast, syncControls, updateOutSize,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window.DC);

/* ===============================================================
   printer.js —— 打印：页面设置、预览、实际输出

   预览与实际打印共用同一套 mm 计算，保证「看到的就是打出来的」。
   实际打印通过临时 #printRoot + 动态 @page 完成，
   不依赖任何第三方库。
   =============================================================== */
(function (DC) {
  "use strict";

  const { $, clamp, makeCanvas, ctx2d, toast } = DC.utils;
  const S = DC.state;

  const PAPERS = {
    A4: [210, 297],
    A5: [148, 210],
    B5: [176, 250],
    Letter: [215.9, 279.4],
  };
  const PAPER_LABEL = {
    A4: "A4", A5: "A5", B5: "B5", Letter: "Letter", custom: "自定义",
  };

  const PREVIEW_BOX = { w: 500, h: 596 };
  const PRINT_MAX = 2400;   // 打印图的像素上限（A4 约 300dpi）

  let printImg = null;      // 处理后的画布
  let layout = null;        // 当前排版结果
  let printRoot = null;
  let pageStyle = null;

  /* ---------- 生成打印用图像 ---------- */
  function buildPrintImage() {
    const base = DC.geometry.buildBase(PRINT_MAX);
    const warped = S.quad ? DC.perspective.warp(base, S.quad) : base;
    return DC.enhance.process(warped, S.srcRev + "-print");
  }

  /* ---------- 排版计算（单位 mm） ---------- */
  function computeLayout() {
    if (!printImg) return null;

    let pw, ph;
    if (S.print.paper === "custom") {
      pw = clamp(Number(S.print.customW) || 210, 50, 1000);
      ph = clamp(Number(S.print.customH) || 297, 50, 1000);
    } else {
      const p = PAPERS[S.print.paper] || PAPERS.A4;
      pw = p[0]; ph = p[1];
    }

    const iw = printImg.width, ih = printImg.height;
    const m = clamp(Number(S.print.margin) || 0, 0, 30);

    let land;
    if (S.print.orientation === "landscape") land = true;
    else if (S.print.orientation === "portrait") land = false;
    else {
      // 自动：选能放得更大的方向
      const a = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
      const b = Math.min((ph - 2 * m) / iw, (pw - 2 * m) / ih);
      land = b > a;
    }
    if (land) { const t = pw; pw = ph; ph = t; }

    const cw = Math.max(1, pw - 2 * m);
    const ch = Math.max(1, ph - 2 * m);

    const scale = S.print.fit === "cover"
      ? Math.max(cw / iw, ch / ih)
      : Math.min(cw / iw, ch / ih);

    const iwMm = iw * scale;
    const ihMm = ih * scale;
    const x = (pw - iwMm) / 2;
    const y = (ph - ihMm) / 2;

    return {
      pw, ph, margin: m, cw, ch,
      iwMm, ihMm, x, y, scale,
      landscape: land,
      paperName: S.print.paper,
    };
  }

  /* ---------- 预览绘制 ---------- */
  function drawPreview() {
    layout = computeLayout();
    const canvas = $("printPreview");
    if (!layout) return;

    const pxPerMm = Math.min(
      PREVIEW_BOX.w / layout.pw,
      PREVIEW_BOX.h / layout.ph
    );
    const w = Math.round(layout.pw * pxPerMm);
    const h = Math.round(layout.ph * pxPerMm);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    const cx = canvas.getContext("2d");
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, w, h);

    // 纸张
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, w, h);

    // 页边距参考线
    if (layout.margin > 0) {
      const mx = layout.margin * pxPerMm;
      cx.save();
      cx.strokeStyle = "rgba(47,109,246,.34)";
      cx.lineWidth = 1;
      cx.setLineDash([4, 4]);
      cx.strokeRect(mx + .5, mx + .5, w - mx * 2 - 1, h - mx * 2 - 1);
      cx.restore();
    }

    // 图片
    const ix = layout.x * pxPerMm;
    const iy = layout.y * pxPerMm;
    const iw = layout.iwMm * pxPerMm;
    const ih = layout.ihMm * pxPerMm;

    cx.save();
    if (S.print.fit === "cover") {
      // 铺满：超出内容区部分裁掉
      const mx = layout.margin * pxPerMm;
      cx.beginPath();
      cx.rect(mx, mx, w - mx * 2, h - mx * 2);
      cx.clip();
    }
    cx.imageSmoothingQuality = "high";
    cx.drawImage(printImg, ix, iy, iw, ih);
    cx.restore();

    // 纸张外框
    cx.strokeStyle = "rgba(18,25,35,.16)";
    cx.lineWidth = 1;
    cx.strokeRect(.5, .5, w - 1, h - 1);

    // 信息
    const pct = Math.round(layout.scale * 100);
    $("printInfo").textContent =
      `${PAPER_LABEL[layout.paperName] || layout.paperName} ` +
      `${layout.pw.toFixed(layout.paperName === "Letter" || layout.paperName === "custom" ? 1 : 0)}` +
      ` × ${layout.ph.toFixed(layout.paperName === "Letter" || layout.paperName === "custom" ? 1 : 0)} mm · ` +
      `${layout.landscape ? "横向" : "纵向"} · 边距 ${layout.margin} mm · 缩放 ${pct}%`;
  }

  /* ---------- 打开 / 关闭 ---------- */
  function open() {
    if (!S.img) return;
    DC.app.setBusy(true, "正在生成打印预览…");

    setTimeout(() => {
      try {
        printImg = buildPrintImage();
        syncControls();
        $("printModal").hidden = false;
        drawPreview();
      } catch (e) {
        toast("生成打印预览失败：" + e.message, "err");
      } finally {
        DC.app.setBusy(false);
      }
    }, 20);
  }

  function close() {
    $("printModal").hidden = true;
    printImg = null;
  }

  function syncControls() {
    $("paperSel").value = S.print.paper;
    $("customPaperRow").hidden = S.print.paper !== "custom";
    $("paperW").value = S.print.customW;
    $("paperH").value = S.print.customH;
    $("margin").value = S.print.margin;
    $("vMargin").textContent = S.print.margin + " mm";

    setSeg("orientSeg", "orient", S.print.orientation);
    setSeg("fitSeg", "fit", S.print.fit);
  }

  function setSeg(id, key, value) {
    DC.utils.$$("#" + id + " button").forEach((b) => {
      b.classList.toggle("on", b.dataset[key] === value);
    });
  }

  /* ---------- 真正打印 ---------- */
  function doPrint() {
    if (!layout || !printImg) return;

    const url = printImg.toDataURL("image/png");
    const { pw, ph, margin, iwMm, ihMm, x, y } = layout;

    // 1) 页面尺寸
    if (pageStyle) pageStyle.remove();
    pageStyle = document.createElement("style");
    pageStyle.id = "print-page-rule";
    pageStyle.textContent = `@page { size: ${pw}mm ${ph}mm; margin: 0; }`;
    document.head.appendChild(pageStyle);

    // 2) 打印内容
    if (printRoot) printRoot.remove();
    printRoot = document.createElement("div");
    printRoot.id = "printRoot";

    const imgStyle =
      `position:absolute;left:${x}mm;top:${y}mm;width:${iwMm}mm;height:${ihMm}mm;`;

    if (S.print.fit === "cover") {
      // 图片被放进裁剪容器，坐标要减去容器原点（页边距），否则会偏移一个边距
      const innerStyle =
        `position:absolute;left:${x - margin}mm;top:${y - margin}mm;` +
        `width:${iwMm}mm;height:${ihMm}mm;`;
      printRoot.innerHTML =
        `<div style="position:absolute;left:${margin}mm;top:${margin}mm;` +
        `width:${layout.cw}mm;height:${layout.ch}mm;overflow:hidden;">` +
        `<img src="${url}" style="${innerStyle}"></div>`;
    } else {
      printRoot.innerHTML = `<img src="${url}" style="${imgStyle}">`;
    }
    document.body.appendChild(printRoot);

    // 3) 等图像解码后再调起打印
    const img = printRoot.querySelector("img");
    const fire = () => {
      const cleanup = () => {
        if (printRoot) { printRoot.remove(); printRoot = null; }
        if (pageStyle) { pageStyle.remove(); pageStyle = null; }
      };
      window.addEventListener("afterprint", cleanup, { once: true });
      try { window.print(); } catch (e) { toast("打印失败：" + e.message, "err"); }
      setTimeout(cleanup, 600);
    };

    if (img && !img.complete) img.onload = fire;
    else fire();
  }

  /* ---------- 事件 ---------- */
  function init() {
    $("btnPrint").addEventListener("click", open);
    $("btnPrintPanel").addEventListener("click", open);
    $("printClose").addEventListener("click", close);
    $("printCancel").addEventListener("click", close);
    $("printGo").addEventListener("click", doPrint);

    $("printModal").addEventListener("click", (e) => {
      if (e.target === $("printModal")) close();
    });

    $("paperSel").addEventListener("change", (e) => {
      S.print.paper = e.target.value;
      $("customPaperRow").hidden = S.print.paper !== "custom";
      DC.store.persist();
      drawPreview();
    });

    ["paperW", "paperH"].forEach((id) => {
      $(id).addEventListener("input", (e) => {
        const v = clamp(Number(e.target.value) || 0, 50, 1000);
        if (id === "paperW") S.print.customW = v;
        else S.print.customH = v;
        DC.store.persist();
        drawPreview();
      });
    });

    $("orientSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-orient]");
      if (!b) return;
      S.print.orientation = b.dataset.orient;
      setSeg("orientSeg", "orient", S.print.orientation);
      DC.store.persist();
      drawPreview();
    });

    $("margin").addEventListener("input", (e) => {
      S.print.margin = Number(e.target.value);
      $("vMargin").textContent = S.print.margin + " mm";
      DC.store.persist();
      drawPreview();
    });

    $("fitSeg").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-fit]");
      if (!b) return;
      S.print.fit = b.dataset.fit;
      setSeg("fitSeg", "fit", S.print.fit);
      DC.store.persist();
      drawPreview();
    });

    window.addEventListener("resize", () => {
      if (!$("printModal").hidden) drawPreview();
    });
  }

  DC.printer = {
    init, open, close, doPrint,
    isOpen: () => !$("printModal").hidden,
  };
})(window.DC);

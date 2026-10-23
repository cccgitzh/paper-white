#!/usr/bin/env node
/**
 * 构建脚本：把 index.html 引用的 CSS / JS 全部内联，产出单文件 dist/paper-white.html。
 * 用途：发给别人时只需要一个文件，双击即可用（file:// 也能跑）。
 *
 * 用法：node tools/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const kb = (s) => (Buffer.byteLength(s, "utf8") / 1024).toFixed(1) + " KB";

let html = read("index.html");
const parts = [];

/* 内联样式表 */
html = html.replace(
  /^[ \t]*<link rel="stylesheet" href="([^"]+)">[ \t]*$/gm,
  (_, href) => {
    const css = read(href);
    parts.push(["css", href, css.length]);
    return `<style>\n/* ===== ${href} ===== */\n${css.trim()}\n</style>`;
  }
);

/* 内联脚本（防止字符串里出现 </script> 提前闭合） */
html = html.replace(
  /^[ \t]*<script src="([^"]+)"><\/script>[ \t]*$/gm,
  (_, src) => {
    const js = read(src).replace(/<\/script/gi, "<\\/script");
    parts.push(["js", src, js.length]);
    return `<script>\n/* ===== ${src} ===== */\n${js.trim()}\n</script>`;
  }
);

html = html.replace(
  "<head>",
  "<head>\n<!-- 构建产物：由 `npm run build` 从 index.html + src/ 生成，请勿直接修改 -->"
);

mkdirSync(join(ROOT, "dist"), { recursive: true });
const outFile = join(ROOT, "dist", "paper-white.html");
writeFileSync(outFile, html, "utf8");

console.log("已内联：");
for (const [kind, file, len] of parts) {
  console.log(`  ${kind.padEnd(3)} ${file.padEnd(26)} ${(len / 1024).toFixed(1)} KB`);
}
console.log(`\n输出 ${outFile}`);
console.log(`体积 ${kb(html)}  大小 ${(statSync(outFile).size / 1024).toFixed(1)} KB`);

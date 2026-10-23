#!/usr/bin/env node
/**
 * 生成「注入了测试代码」的临时页面，配合无头 Chrome 做断言与截图。
 *
 * 用法：
 *   node tools/test-page.mjs index.html _t.html "setTimeout(()=>document.getElementById('btnSample').click(),200)"
 *
 * 断言输出建议写入 document.title，再用：
 *   chrome --headless=new --window-size=1440,900 --virtual-time-budget=20000 \
 *          --dump-dom file:///abs/_t.html | grep -o "<title>[^<]*</title>"
 * 取回结果。
 */
import { readFileSync, writeFileSync } from "node:fs";

const [src, dst, code] = process.argv.slice(2);
if (!src || !dst || !code) {
  console.error("用法: node tools/test-page.mjs <源html> <输出html> <js片段>");
  process.exit(1);
}

const html = readFileSync(src, "utf8");

const injection = `<script>
(function () {
  window.alert = (m) => { document.title = "ALERT " + m; };
  window.onerror = (m, f, l) => {
    document.title = "ERR " + m + " @" + String(f).split("/").pop() + ":" + l;
  };
${code}
})();
</script>
</body>`;

writeFileSync(dst, html.replace("</body>", injection), "utf8");
console.log("已生成 " + dst);

// 手机抽屉 · 史卷开门即见（移动端契约）：窄屏不展示舆图，点开抽屉第一屏就是史卷。
// 线上问题：舆图 SVG 是 100×100 方图，抽屉里按 min-width:520px 放大横滚铺开后
// 高约 520px，把 78dvh 的底部抽屉整屏占满——史卷（每天的大事笔）被挤出视口，
// 用户点「舆图」钮想看历史更新，却要先滚过一张要横滑的大地图。
// 拍板：地图暂无玩法交互，窄屏抽屉整卡让位给史卷；桌面侧栏舆图与「大观」不受影响。
// app.js 顶层即触 DOM、CSS 无 headless 环境，与 mapbig-tap.test.js 同法：以源码契约钉住实现不回退。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../../packages/web/public/style.css'), 'utf8');
const html = readFileSync(join(here, '../../packages/web/public/index.html'), 'utf8');
const appJs = readFileSync(join(here, '../../packages/web/public/app.js'), 'utf8');

/** 取第 nth 个指定查询的 @media 块正文（花括号配平；本文件 media 内不嵌套 media） */
function mediaBlock(cssText, query, nth = 0) {
  const re = new RegExp(query.replace(/[()]/g, '\\$&'), 'g');
  const hits = [...cssText.matchAll(re)];
  const at = hits[nth];
  if (!at) return null;
  const open = cssText.indexOf('{', at.index);
  let depth = 0;
  for (let i = open; i < cssText.length; i++) {
    if (cssText[i] === '{') depth++;
    else if (cssText[i] === '}') { depth--; if (!depth) return cssText.slice(open + 1, i); }
  }
  return null;
}

describe('手机抽屉 · 史卷开门即见（移动端契约）', () => {
  const narrow = mediaBlock(css, '@media (max-width: 760px)');

  test('窄屏响应式块存在，且整张舆图卡在抽屉里不展示', () => {
    assert.ok(narrow, 'style.css 需保留 (max-width: 760px) 响应式块');
    assert.match(narrow, /#map-panel\s*\{\s*display:\s*none/, '窄屏抽屉里 #map-panel 必须 display:none——方图占满抽屉会把史卷挤出视口');
  });

  test('史卷不得随舆图一起被藏：抽屉的主客不能对调', () => {
    assert.doesNotMatch(narrow, /#chronicle-panel\s*\{\s*display:\s*none/, '史卷是窄屏抽屉的主角，不得隐藏');
  });

  test('舆图不得以「放大横滚」回窄屏抽屉（520px 方图即本病灶）', () => {
    assert.doesNotMatch(narrow, /\.map-svg\s*\{\s*min-width:\s*520px/, '舆图要回窄屏须重新拍板尺寸与入口，不得恢复 520px 横滚方案');
  });

  test('桌面舆图原样在翼上：主样式仍排版 #map-panel 而非隐藏', () => {
    assert.match(css, /#map-panel\s*\{\s*flex:\s*none;?\s*\}/, '桌面侧栏舆图卡的排版规则不得动');
  });

  test('入口如实：手机抽屉钮与抽屉头不再自称舆图', () => {
    const btn = html.match(/<button id="btn-wing"[\s\S]*?<\/button>/)?.[0] || '';
    assert.ok(btn, 'index.html 需保留 #btn-wing（窄屏开抽屉的入口）');
    assert.doesNotMatch(btn, /舆图/, '抽屉钮点开的是史卷，不得再写舆图');
    const head = appJs.match(/wing-drawer-head[\s\S]{0,220}/)?.[0] || '';
    assert.ok(head, 'app.js 需保留抽屉头（合上抽屉的手）');
    assert.doesNotMatch(head, /舆图/, '抽屉头不得再写舆图');
  });
});

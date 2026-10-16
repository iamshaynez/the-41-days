// 舆图大观 · 点名出注（移动端契约）：手机上「地图点开看不到地名信息」的线上回归守护。
// 根因：stage 上 setPointerCapture 之后，手机浏览器（iOS Safari 等）会把后续 click 的
// target 改写为 stage，挂在 .mb-sheet 上的 click 出注永远 closest 不到 g.place；
// 叠加单次 pointermove 位移 >1px 即判拖拽，手指 tap 的手抖也会吞掉出注。
// 修复契约：出注在 pointerup 自判 tap（累计位移 MB_TAP_SLOP + 按压时长阈值），
// 命中走 document.elementFromPoint 真实命中测试；键盘出注由 keydown 补位。
// app.js 顶层即触 DOM 无法在 node 里 import，这里以源码契约钉住实现方式不回退。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appJs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../packages/web/public/app.js'), 'utf8');

describe('舆图大观 · 点名出注（移动端契约）', () => {
  test('出注走 pointerup 自判 tap：累计位移阈值 + elementFromPoint 命中', () => {
    assert.match(appJs, /MB_TAP_SLOP/, 'tap 需按累计位移判——单次 move >1px 判拖拽会吞掉手机 tap 的手抖');
    assert.match(appJs, /elementFromPoint/, '命中需走 elementFromPoint 真实命中测试——capture 期间 click 的 target 靠不住');
    assert.match(appJs, /addEventListener\('pointercancel', drop\)/, '手势被打断（pointercancel）只清理指针、不出注');
  });

  test('出注不得挂回 .mb-sheet 的 click——手机上 capture 改写 click target，必然全灭', () => {
    assert.doesNotMatch(appJs, /mb-sheet'\)\.addEventListener\('click'/, '出注必须走 pointerup 自判，不得回退到 sheet click');
  });

  test('键盘仍可出注：地名 tabindex=0，Enter/Space 经 keydown 出注', () => {
    assert.match(appJs, /mb-sheet'\)\.addEventListener\('keydown'/, '删除 click 出注后，键盘可达性由 keydown 补位');
  });
});

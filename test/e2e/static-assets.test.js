// 静态资源版本化 e2e：HTML 里的 js/css 引用带内容哈希（?v=……），版本化资源可长缓存。
// 动机：无版本标识时，缓存不规范的浏览器/WebView 可能拿新 index.html 配旧 app.js
// （0.3.0 单一难度上线时即出现：旧脚本找 #difficulty 直接抛错，「住进去」开不了局）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../../packages/server/index.js';
import { applyMigrations } from '../../packages/server/migrate.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let app, base, dir;
const here = dirname(fileURLToPath(import.meta.url));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'twom-static-'));
  applyMigrations(join(dir, 'game.db'));
  app = createApp({ dbPath: join(dir, 'game.db'), adminUsername: 'admin', adminPassword: 'test-admin-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); app.db.close(); rmSync(dir, { recursive: true, force: true }); });

const hashOf = (rel) => createHash('sha256').update(readFileSync(join(here, '../../packages/web/public', rel))).digest('hex').slice(0, 8);

describe('静态资源 · 版本化', () => {
  test('GET /app 与 GET / 的 js/css 引用带 ?v=内容哈希；HTML 本身协商缓存', async () => {
    for (const [path, ref] of [['/app', 'app.js'], ['/', 'landing.js']]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') || '', /no-cache/);
      const html = await res.text();
      const m = html.match(new RegExp(`(?:src|href)="/${ref.replace('.', '\\.')}\\?v=([0-9a-f]{8})"`));
      assert.ok(m, `${path} 引用 ${ref} 应带 ?v= 八位哈希`);
      assert.equal(m[1], hashOf(ref), `${ref} 的 ?v= 应等于其内容哈希`);
    }
    // 样式表同样版本化
    const html = await (await fetch(base + '/app')).text();
    assert.match(html, /\/style\.css\?v=[0-9a-f]{8}/);
  });

  test('版本化 js/css 长缓存；无版本 URL 仍可用且协商缓存（旧书签兼容）', async () => {
    const v = hashOf('app.js');
    const fresh = await fetch(`${base}/app.js?v=${v}`);
    assert.equal(fresh.status, 200);
    assert.match(fresh.headers.get('cache-control') || '', /max-age=604800/);
    const bare = await fetch(`${base}/app.js`);
    assert.equal(bare.status, 200);
    assert.match(bare.headers.get('cache-control') || '', /no-cache/);
  });

  test('app.js 的模块导入（icons/typist/sfx）同样带版本——新旧脚本不可能混搭', async () => {
    const body = await (await fetch(`${base}/app.js`)).text();
    for (const mod of ['icons', 'typist', 'sfx']) {
      const m = body.match(new RegExp(`from '\\./${mod}\\.js\\?v=([0-9a-f]{8})'`));
      assert.ok(m, `app.js 应以带 ?v= 的路径导入 ${mod}.js`);
      assert.equal(m[1], hashOf(`${mod}.js`), `${mod}.js 的版本号应等于其内容哈希`);
    }
  });
});

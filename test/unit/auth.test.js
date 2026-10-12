// L1 单元：认证原语（scrypt 哈希 / 校验器 / cookie 序列化）——纯函数，零 I/O。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validateUsername, validatePassword, sessionCookie, clearSessionCookie } from '../../packages/server/auth.js';

describe('口令哈希', () => {
  test('哈希-校验回路；同一口令两次哈希盐不同', () => {
    const h1 = hashPassword('围城口令');
    const h2 = hashPassword('围城口令');
    assert.notEqual(h1, h2, '盐应随机');
    assert.ok(verifyPassword('围城口令', h1));
    assert.ok(verifyPassword('围城口令', h2));
    assert.equal(verifyPassword('围城口令2', h1), false);
    assert.equal(verifyPassword('', h1), false);
  });
  test('存储串格式自描述（scrypt$N$r$p$salt$hash）', () => {
    const h = hashPassword('x'.repeat(20));
    const parts = h.split('$');
    assert.equal(parts[0], 'scrypt');
    assert.equal(parts.length, 6);
    assert.ok(Number(parts[1]) >= 16384, '代价因子下限');
  });
  test('损坏/异构存储串按不匹配处理（不抛错）', () => {
    assert.equal(verifyPassword('whatever', null), false);
    assert.equal(verifyPassword('whatever', ''), false);
    assert.equal(verifyPassword('whatever', 'plaintext-old'), false);
    assert.equal(verifyPassword('whatever', 'bcrypt$2a$10$xxx$yyy'), false);
  });
});

describe('用户名/口令校验', () => {
  test('用户名：2–24 位 unicode 字母/数字/_/-', () => {
    assert.equal(validateUsername('anton'), null);
    assert.equal(validateUsername('布罗'), null);
    assert.equal(validateUsername('a_b-c9'), null);
    assert.ok(validateUsername('a'));                    // 太短
    assert.ok(validateUsername('a'.repeat(25)));         // 太长
    assert.ok(validateUsername('bad space'));            // 空格
    assert.ok(validateUsername('bad@name'));             // 符号
    assert.ok(validateUsername(42));                     // 非字符串
    assert.ok(validateUsername(null));
  });
  test('口令：6–128 位', () => {
    assert.equal(validatePassword('secret'), null);
    assert.equal(validatePassword('x'.repeat(128)), null);
    assert.ok(validatePassword('12345'));
    assert.ok(validatePassword('x'.repeat(129)));
    assert.ok(validatePassword(null));
  });
});

describe('会话 cookie 序列化', () => {
  test('签发带 HttpOnly/SameSite/Max-Age；清除 Max-Age=0', () => {
    const c = sessionCookie('twom_session', 'tok123', 86400);
    assert.match(c, /^twom_session=tok123; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400$/);
    assert.match(clearSessionCookie('twom_session'), /Max-Age=0$/);
  });
});

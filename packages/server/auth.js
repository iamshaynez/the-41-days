// 账号认证原语（ADR-001 零依赖）：scrypt 加盐哈希 + 常量时间比较 + 字段校验。
// 会话管理（token 表）在 index.js——本文件只做纯函数，可单测。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 };

/** 哈希口令 → "scrypt$N$r$p$salt_b64$hash_b64"（自描述格式，参数升级可平滑迁移） */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keyLen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** 校验口令。存储串损坏按不匹配处理（不抛错）；长度不一致时垫齐后常量时间比较。 */
export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64');
    const hash = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return expected.length === hash.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

/** 用户名：2–24 个 unicode 字母/数字/下划线/连字符（不含空白与符号，避免视觉混淆） */
export function validateUsername(name) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_-]{2,24}$/u.test(name)) {
    return '用户名需 2–24 个字母、数字、下划线或连字符';
  }
  return null;
}

/** 口令：6–128 位（游戏账号，非银行；管理员由环境变量注入另有强口令建议） */
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 128) return '口令需 6–128 位';
  return null;
}

/** HttpOnly 会话 cookie（SameSite=Lax 防 CSRF：跨站 POST 不带 cookie；JSON content-type 本就跨域不可发） */
export function sessionCookie(name, token, maxAgeSec) {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
export function clearSessionCookie(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const publicUser = (u) => (u ? { id: u.id, name: u.name, is_admin: !!u.is_admin, created_at: u.created_at } : null);

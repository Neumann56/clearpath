/**
 * 操作人身份（MVP）
 *
 * 为什么要有这个：双人复核的全部意义在于"提的人和批的人不是同一个"。
 * 如果 actor 从请求体里取，同一个浏览器改个名字就能绕过 E_REVIEWER_IS_AUTHOR，
 * 那这个校验等于没有。所以 actor 必须由服务端从请求头解析。
 *
 * 这里是 MVP：固定 key 表 + X-Operator-Key 头，不做完整登录。
 * 接账号体系时，把 resolveOperator() 换成读会话即可，其余调用点不用动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './params.js';

export const OPERATORS_FILE = path.join(RUNTIME_DIR, 'operators.json');

// 文件不存在时用这份兜底，保证开箱能用；存在则以文件为准
const BUILTIN = {
  'ops-alice': { name: '运营 A', role: '复核人' },
  'ops-bob': { name: '运营 B', role: '复核人' },
  'ops-carol': { name: '运营 C', role: '主管' },
  'ops-dave': { name: '运营 D', role: '复核人' },
};

export function loadOperators() {
  try {
    const raw = JSON.parse(fs.readFileSync(OPERATORS_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && Object.keys(raw).length) return raw;
  } catch {
    /* 没有文件就用内置表 */
  }
  return BUILTIN;
}

export function operatorName(key) {
  const ops = loadOperators();
  return ops[key]?.name || key || '—';
}

export function isValidOperator(key) {
  return !!key && Object.prototype.hasOwnProperty.call(loadOperators(), key);
}

/**
 * 从请求解析操作人。顺序：X-Operator-Key → Basic 认证。
 * 都拿不到返回 null（调用方回 401）。
 */
export function resolveOperator(req, basicUser = null) {
  const key = String(req.headers['x-operator-key'] || '').trim();
  if (key) {
    if (!isValidOperator(key)) return { key, invalid: true };
    const ops = loadOperators();
    return { key, name: ops[key].name, role: ops[key].role || '复核人', invalid: false };
  }
  if (basicUser) return { key: basicUser, name: '管理员', role: '管理员', invalid: false };
  return null;
}

/** 列表给前端下拉用（内网页面，不暴露给公网） */
export function operatorList() {
  return Object.entries(loadOperators()).map(([key, v]) => ({ key, name: v.name, role: v.role || '' }));
}

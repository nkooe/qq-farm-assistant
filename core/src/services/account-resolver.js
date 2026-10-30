/**
 * 标准化内部账号 ID，仅接受单个字符串或整数。
 * @param {*} ref - 内部账号 ID
 * @returns {string} 标准化后的账号标识
 */
function normalizeAccountRef(ref) {
  if (typeof ref !== 'string' && !(typeof ref === 'number' && Number.isSafeInteger(ref))) return '';
  return String(ref).trim();
}

/**
 * 按引用查找账号
 * @param {Array<object>} accountList - 账号列表
 * @param {*} ref - 内部账号 ID
 * @returns {object | null} 匹配的账号对象
 */
function findAccountByRef(accountList, ref) {
  const target = normalizeAccountRef(ref);
  if (!target) return null;
  const list = Array.isArray(accountList) ? accountList : [];
  for (const account of list) {
    if (!account || typeof account !== 'object') continue;
    if (normalizeAccountRef(account.id) === target) return account;
  }
  return null;
}

/**
 * 按引用解析账号 ID
 * @param {Array<object>} accountList - 账号列表
 * @param {*} ref - 账号引用
 * @returns {string} 账号 ID 字符串
 */
function resolveAccountId(accountList, ref) {
  const account = findAccountByRef(accountList, ref);
  if (!account) return '';
  return normalizeAccountRef(account.id);
}

module.exports = {
  normalizeAccountRef,
  findAccountByRef,
  resolveAccountId
};

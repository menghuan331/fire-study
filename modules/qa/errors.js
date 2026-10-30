/** Public, serializable failures. Never display a raw fetch exception or credential. */
const messages = {
  NOT_CONFIGURED: '还没设置模型。请到设置 → 当场问配置后再试。问题已保留。',
  UNAUTHORIZED: '模型钥匙缺失或失效。请到设置 → 当场问检查钥匙后重试。问题已保留。',
  WRONG_CREDENTIAL: '这里需要答疑专用凭证，不能使用 GitHub 同步令牌。',
  NO_BALANCE: '模型账户余额不足或额度用完了。请到厂商控制台充值后重试，问题已保留。',
  DAILY_LIMIT: '今天的提问次数用完了，明天再问。问题已保留。',
  RATE_LIMITED: '答疑请求较多，请稍后重试。问题已保留。',
  TIMEOUT: '等待回答超时。问题已保留，可以重试同一个问题。',
  UNAVAILABLE: '答疑服务暂时不可用，请稍后重试。',
  NETWORK_ERROR: '网络连接中断，或答疑服务暂时无法连接。问题已保留，请稍后重试。',
  INVALID_RESPONSE: '答疑服务返回的内容无法验证，请重试。',
  INVALID_CITATION: '回答的教材引用未通过核对，未将它作为有效回答保存。请重试。',
  INVALID_REQUEST: '问题或教材上下文不符合要求，请检查后重新提问。',
  CONTEXT_CHANGED: '教材片段已经变化。请把问题带入输入框，按当前片段重新提问。',
  REMOVED: '这条疑问已移除，回答不会再写入。',
  SAVE_FAILED: '问题尚未成功保存，暂未发送。请保留输入并重试。',
  ABORTED: '已停止等待；保存的问题仍可重试。'
};

export class QaError extends Error {
  constructor(code, message, { retryable, status, retryAfter } = {}) {
    super(message || messages[code] || messages.UNAVAILABLE);
    this.name = 'QaError';
    this.code = code;
    this.retryable = retryable === undefined ? code !== 'DAILY_LIMIT' : retryable;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function errorRecord(error) {
  const safe = error instanceof QaError ? error : new QaError('NETWORK_ERROR');
  return {
    code: safe.code,
    message: safe.message,
    retryable: !!safe.retryable,
    ...(safe.status === undefined ? {} : { status: safe.status }),
    ...(safe.retryAfter === undefined ? {} : { retryAfter: safe.retryAfter })
  };
}

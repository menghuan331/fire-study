/** Public, serializable failures. Never display a raw fetch exception or credential. */
const messages = {
  NOT_CONFIGURED: '答疑服务尚未配置。问题已经保留，接通服务后可重试。',
  UNAUTHORIZED: '答疑凭证缺失或已失效。请设置答疑专用凭证后重试。',
  WRONG_CREDENTIAL: '这里需要答疑专用凭证，不能使用 GitHub 同步令牌。',
  RATE_LIMITED: '答疑请求较多，请稍后重试。问题已保留。',
  TIMEOUT: '等待回答已超过 30 秒。问题已保留，可以重试同一个问题。',
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
  constructor(code, message, { retryable = true, status, retryAfter } = {}) {
    super(message || messages[code] || messages.UNAVAILABLE);
    this.name = 'QaError';
    this.code = code;
    this.retryable = retryable;
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

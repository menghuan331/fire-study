/** Public, serializable failures. Never display a raw fetch exception or credential. */
const messages = {
  NOT_CONFIGURED: '还没设置模型。请到设置 → 当场问配置后再试。问题已保留。',
  UNAUTHORIZED: '模型钥匙缺失或失效。请到设置 → 当场问检查钥匙后重试。问题已保留。',
  WRONG_CREDENTIAL: '这里需要答疑专用凭证，不能使用 GitHub 同步令牌。',
  NO_BALANCE: '模型账户余额不足或额度用完了。请到厂商控制台充值后重试，问题已保留。',
  RATE_LIMITED: '答疑请求较多，请稍后重试。问题已保留。',
  TIMEOUT: '等待回答超时。问题已保留，可以重试同一个问题。',
  UNAVAILABLE: '答疑服务暂时不可用，请稍后重试。',
  NETWORK_ERROR: '网络连接中断，或答疑服务暂时无法连接。问题已保留，请稍后重试。',
  EMPTY: '模型这次没回答，再问一次',
  TRUNCATED: '回答太长被截断了，再问一次',
  INVALID_RESPONSE: '模型这次没返回能用的内容，问题已保留，可以再试一次。',
  INVALID_CITATION: '回答的教材引用未通过核对，未将它作为有效回答保存。请重试。',
  INVALID_REQUEST: '问题或教材上下文不符合要求，请检查后重新提问。',
  CONTEXT_CHANGED: '教材片段已经变化。请把问题带入输入框，按当前片段重新提问。',
  REMOVED: '这条疑问已移除，回答不会再写入。',
  SAVE_FAILED: '问题尚未成功保存，暂未发送。请保留输入并重试。',
  ABORTED: '已停止等待；保存的问题仍可重试。'
};

export class QaError extends Error {
  constructor(code, message, { retryable, status = 0, retryAfter, finish_reason = null, snippet = "" } = {}) {
    super(message || messages[code] || messages.UNAVAILABLE);
    this.name = 'QaError';
    this.code = code;
    this.finish_reason = finish_reason;
    this.snippet = snippet;
    this.retryable = retryable === undefined ? true : retryable;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function errorRecord(error) {
  const safe = error instanceof QaError ? error : new QaError('NETWORK_ERROR');
  return {
    code: safe.code,
    status: safe.status ?? 0,
    finish_reason: safe.finish_reason ?? null,
    snippet: safe.snippet || "",
    message: safe.message,
    retryable: !!safe.retryable,
    ...(safe.retryAfter === undefined ? {} : { retryAfter: safe.retryAfter })
  };
}

/** Redact before clipping so a key crossing the 200-character boundary cannot leak. */
export function failureDetails(status = 0, finish_reason = null, raw = "", key = "") {
  let safe = String(raw || "");
  if (key) safe = safe.split(key).join("[REDACTED]");
  safe = safe.replace(/(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/("(?:data|base64)"\s*:\s*")[A-Za-z0-9+/=]{16,}/g, "$1[IMAGE]")
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[IMAGE]");
  if (finish_reason != null) finish_reason = String(finish_reason).split(key || "\0").join("[REDACTED]").slice(0, 40);
  return { status, finish_reason, snippet: Array.from(safe).slice(0, 200).join("") };
}

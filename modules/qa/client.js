import { QaError } from './errors.js';
import { LIMITS, stableStringify, validateRequest, validateResponse } from './state.js';

function endpointUrl(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.trim()) throw new QaError('NOT_CONFIGURED');
  let url;
  try { url = new URL(endpoint, globalThis.location?.href); }
  catch { throw new QaError('NOT_CONFIGURED'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.hash || url.search) throw new QaError('NOT_CONFIGURED');
  return url.href;
}

function httpError(response, body) {
  let code = response.status === 401 || response.status === 403 ? 'UNAUTHORIZED'
    : response.status === 429 ? 'RATE_LIMITED'
      : response.status === 408 || response.status === 504 ? 'TIMEOUT'
        : response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST';
  const aliases = {
    not_configured: 'NOT_CONFIGURED', unauthorized: 'UNAUTHORIZED', forbidden: 'UNAUTHORIZED',
    rate_limited: 'RATE_LIMITED', timeout: 'TIMEOUT', upstream_timeout: 'TIMEOUT',
    service_unavailable: 'UNAVAILABLE', unavailable: 'UNAVAILABLE',
    invalid_citation: 'INVALID_CITATION', invalid_response: 'INVALID_RESPONSE', invalid_request: 'INVALID_REQUEST'
  };
  const supplied = String(body?.error?.code || '').toLowerCase();
  if (aliases[supplied] && ![401, 403, 429].includes(response.status)) code = aliases[supplied];
  const retryAfter = Number(response.headers?.get?.('Retry-After'));
  return new QaError(code, undefined, { status: response.status,
    retryable: typeof body?.error?.retryable === 'boolean' ? body.error.retryable : code !== 'INVALID_REQUEST',
    ...(retryAfter > 0 && Number.isFinite(retryAfter) ? { retryAfter } : {}) });
}

/** endpoint is the complete /v1/qa/answer URL. getAccessToken is dedicated to QA only. */
export function createClient({ endpoint = '', getAccessToken = () => '', fetchImpl = globalThis.fetch,
  timeoutMs = LIMITS.timeout } = {}) {
  const timeout = Math.min(LIMITS.timeout, Math.max(1, Number(timeoutMs) || LIMITS.timeout));
  const inFlight = new Map();
  return {
    configured: !!endpoint,
    answer(request, { signal } = {}) {
      let payload;
      try { payload = JSON.parse(JSON.stringify(validateRequest(request))); }
      catch (error) { return Promise.reject(error); }
      const signature = stableStringify(payload);
      const existing = inFlight.get(payload.requestId);
      if (existing) return existing.signature === signature ? existing.promise
        : Promise.reject(new QaError('INVALID_REQUEST', '同一请求 ID 不能用于另一个问题，请重新提问。', { retryable: false }));
      const controller = new AbortController();
      let timer, onAbort;
      const canceled = new Promise((resolve, reject) => {
        onAbort = () => { controller.abort(); reject(new QaError('ABORTED')); };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new QaError('TIMEOUT')); }, timeout);
      });
      const operation = (async () => {
        const url = endpointUrl(endpoint);
        if (signal?.aborted) throw new QaError('ABORTED');
        let token;
        try { token = String(await getAccessToken() || '').trim(); }
        catch { throw new QaError('UNAUTHORIZED'); }
        if (controller.signal.aborted) throw new QaError('ABORTED');
        if (!token) throw new QaError('UNAUTHORIZED');
        // Defense in depth: accidental injection of a common GitHub token must never reach fetch.
        if (/^(?:gh[pousr]_|github_pat_)/i.test(token)) throw new QaError('WRONG_CREDENTIAL', undefined, { retryable: false });
        if (typeof fetchImpl !== 'function') throw new QaError('UNAVAILABLE');
        let response;
        try {
          response = await fetchImpl(url, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload), signal: controller.signal, credentials: 'omit',
            redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
        } catch (error) {
          if (controller.signal.aborted) throw new QaError('ABORTED');
          throw new QaError('NETWORK_ERROR');
        }
        let body;
        try { body = await response.json(); }
        catch {
          if (!response.ok) throw httpError(response, null);
          throw new QaError('INVALID_RESPONSE');
        }
        if (!response.ok) {
          if (body?.requestId && body.requestId !== payload.requestId) throw new QaError('INVALID_RESPONSE');
          throw httpError(response, body);
        }
        return validateResponse(payload, body);
      })();
      const promise = Promise.race([operation, canceled]).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (inFlight.get(payload.requestId)?.promise === promise) inFlight.delete(payload.requestId);
      });
      inFlight.set(payload.requestId, { signature, promise });
      return promise;
    }
  };
}

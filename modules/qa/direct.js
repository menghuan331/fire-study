import { QaError } from './errors.js';
import { stableStringify, validateRequest, validateResponse } from './state.js';

export const SYSTEM_PROMPT = `你是注册消防工程师备考的讲解老师。读者 Billy 是在职的电信设计工程师：火灾报警、供配电、应急照明比较熟，建筑防火和水系统比较弱。他不爱读大段文字，看不太懂图，需要你把道理讲透，而不是复述教材。

回答要求：
1. 第一句直接回答他问的，用大白话。
2. 接着讲「为什么」：背后的物理或工程道理（烟怎么走、热怎么传、电怎么供、设备怎么动作），让他能自己把规定推出来。可以用教材以外的工程常识。
3. 指出原文里对应的那一句，必须从【原文片段】里逐字摘抄，放进 quotes。
4. 有容易混的说法或数字，用一句话点出来；这个点常考的话，用一句话说一般怎么考。
5. 总共 3～6 句。不要客套，不要写“教材写明”“根据原文”这种复读，不要编造你不确定的数字或规范条文号。
6. 如果原文片段不够回答，就说清缺什么，status 用 insufficient_context。
7. 原文片段里有图片时，你看不到图本身，只能根据图题和上下文讲；需要看图才能回答时，要说明这一点。

只输出一个 JSON 对象，不要输出其他文字：
{"status":"answered 或 insufficient_context","text":"讲解正文","basis":"教材 或 推理","quotes":[{"anchor":"原文片段里的 anchor","text":"逐字摘抄"}],"followUp":"可选，一句建议他接着想的问题"}
basis 规则：主要靠原文就填“教材”，用到了教材以外的道理就填“推理”。`;

const PROVIDERS = new Set(['deepseek', 'dashscope', 'anthropic', 'openai-compatible']);
const OPENAI_URL = {
  deepseek: 'https://api.deepseek.com/chat/completions',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
};
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GITHUB_TOKEN = /^(gh[pousr]_|github_pat_)/i;
const BALANCE = /insufficient balance|余额不足|quota/i;
const EDGE = new Set(Array.from(' \t\r\n\u3000"\'“”‘’「」『』《》〈〉（）()[]【】{}，。！？、；：,.!?;:…—-·~～`'));

function trimmed(value) {
  return String(value ?? '').trim();
}

function providerName(value) {
  const name = trimmed(value);
  return PROVIDERS.has(name) ? name : '';
}

function compatibleUrl(baseUrl) {
  let url;
  try { url = new URL(trimmed(baseUrl)); }
  catch { throw new QaError('NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new QaError('NOT_CONFIGURED');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  url.search = '';
  url.hash = '';
  return url.href;
}

function userContent(request) {
  const place = trimmed(request.label) || `${request.unit}/${request.chunkId}`;
  const lines = request.context.map(part => `[${part.anchor}] (${part.kind}) ${part.text}`);
  return `【教材位置】${place}\n【原文片段】\n${lines.join('\n')}\n【我的问题】${request.question}`;
}

function historyMessages(history) {
  return history.map(message => ({ role: message.role, content: message.content }));
}

function openaiBody(model, messages, jsonMode) {
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    temperature: 0.3,
    max_tokens: 1200
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

function anthropicBody(model, messages) {
  return { model, system: SYSTEM_PROMPT, messages, max_tokens: 1200, temperature: 0.3 };
}

function headersFor(style, key) {
  if (style === 'anthropic') return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}

function stripEdges(value) {
  let start = 0;
  let end = value.length;
  while (start < end && EDGE.has(value[start])) start += 1;
  while (end > start && EDGE.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function matchedQuote(original, text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  if (original.includes(text)) return text;
  const stripped = stripEdges(text);
  if (stripped && stripped !== text && original.includes(stripped)) return stripped;
  return '';
}

function verifiedQuotes(request, quotes) {
  if (!Array.isArray(quotes)) return [];
  const kept = [];
  for (const quote of quotes) {
    if (!quote || typeof quote.anchor !== 'string' || typeof quote.text !== 'string') continue;
    const original = request.context.find(part => part.anchor === quote.anchor);
    if (!original) continue;
    const text = matchedQuote(original.text, quote.text);
    if (text) kept.push({ anchor: quote.anchor, text });
  }
  return kept;
}

function firstSentence(text) {
  const parts = String(text || '').split(/[。；;\n]/);
  for (const part of parts) {
    const sentence = part.trim();
    if (!sentence) continue;
    const chars = Array.from(sentence);
    return chars.length > 120 ? chars.slice(0, 120).join('') : sentence;
  }
  return '';
}

function fallbackQuote(request) {
  const suffix = `:b${request.blockId}`;
  const part = request.context.find(item => item.anchor.endsWith(suffix)) || request.context[0];
  if (!part) return null;
  const text = firstSentence(part.text);
  if (!text || !part.text.includes(text)) return null;
  return { anchor: part.anchor, text };
}

function firstJsonObject(source) {
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const ch = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(source.slice(start, index + 1)); }
          catch { break; }
        }
      }
    }
  }
  return null;
}

function extractJsonObject(text) {
  const source = String(text || '');
  const chunks = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let match = fence.exec(source); match; match = fence.exec(source)) chunks.push(match[1]);
  chunks.push(source);
  for (const chunk of chunks) {
    const parsed = firstJsonObject(chunk);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  throw new QaError('INVALID_RESPONSE');
}

function modelOutput(style, data) {
  if (!data || typeof data !== 'object') return '';
  if (style === 'anthropic') {
    if (!Array.isArray(data.content)) return '';
    return data.content.filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('');
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join('');
}

function assemble(request, parsed, provider, model, clock, key) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new QaError('INVALID_RESPONSE');
  const status = parsed.status;
  if (status !== 'answered' && status !== 'insufficient_context') throw new QaError('INVALID_RESPONSE');
  let quotes = verifiedQuotes(request, parsed.quotes);
  if (status === 'answered' && quotes.length === 0) {
    const fallback = fallbackQuote(request);
    if (fallback) quotes = [fallback];
  }
  const response = {
    v: 1,
    requestId: request.requestId,
    threadId: request.threadId,
    status,
    answer: {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      // Models sometimes drift from the two labels; anything else is treated as reasoning.
      basis: parsed.basis === '教材' ? '教材' : '推理',
      by: `${provider}/${model}`,
      at: new Date(clock()).toISOString(),
      quotes
    }
  };
  if (typeof parsed.followUp === 'string' && parsed.followUp.trim()) response.followUp = parsed.followUp;
  const validated = validateResponse(request, response);
  const visible = [validated.answer.text, validated.followUp || '',
    ...validated.answer.quotes.map(quote => `${quote.anchor}\n${quote.text}`)].join('\n');
  if (key && visible.includes(key)) throw new QaError('INVALID_RESPONSE');
  return validated;
}

function httpFailure(status, raw) {
  const text = String(raw || '');
  if (status === 401 || status === 403) return new QaError('UNAUTHORIZED', undefined, { status });
  if (status === 429) return new QaError('RATE_LIMITED', undefined, { status });
  if (status >= 500 && status <= 599) return new QaError('UNAVAILABLE', undefined, { status });
  if (status === 402 || (status >= 400 && status < 500 && BALANCE.test(text)))
    return new QaError('NO_BALANCE', undefined, { status });
  if (status >= 400 && status < 500) return new QaError('INVALID_REQUEST', undefined, { status, retryable: false });
  return null;
}

async function send(fetchImpl, url, headers, body, signal, stopOf) {
  if (typeof fetchImpl !== 'function') throw new QaError('UNAVAILABLE');
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal,
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'
    });
  } catch {
    const stop = stopOf();
    if (stop === 'timeout') throw new QaError('TIMEOUT');
    if (stop === 'aborted' || signal?.aborted) throw new QaError('ABORTED');
    throw new QaError('NETWORK_ERROR');
  }
  let raw = '';
  try { raw = await response.text(); }
  catch {
    const stop = stopOf();
    if (stop === 'timeout') throw new QaError('TIMEOUT');
    if (stop === 'aborted' || signal?.aborted) throw new QaError('ABORTED');
    throw new QaError('NETWORK_ERROR');
  }
  return { ok: response.ok, status: response.status, raw };
}

/** Browser-direct model client. Same answer() contract as createClient. The key stays in memory for the request only. */
export function createDirectClient({ provider, model, baseUrl, getApiKey = () => '', fetchImpl = globalThis.fetch,
  timeoutMs = 60000, now = () => Date.now() } = {}) {
  const timeout = Math.max(1, Number(timeoutMs) || 60000);
  const inFlight = new Map();
  const name = providerName(provider);
  const modelName = trimmed(model);

  function readKeySync() {
    try {
      const value = getApiKey();
      if (value && typeof value.then === 'function') return '';
      return trimmed(value);
    } catch { return ''; }
  }

  return {
    get configured() {
      return !!(name && modelName && readKeySync());
    },
    answer(request, { signal } = {}) {
      let payload;
      try { payload = JSON.parse(JSON.stringify(validateRequest(request))); }
      catch (error) { return Promise.reject(error); }
      const signature = stableStringify(payload);
      const existing = inFlight.get(payload.requestId);
      if (existing) return existing.signature === signature ? existing.promise
        : Promise.reject(new QaError('INVALID_REQUEST', '同一请求 ID 不能用于另一个问题，请重新提问。', { retryable: false }));

      const controller = new AbortController();
      let timer;
      let stop = '';
      let onAbort;
      const canceled = new Promise((resolve, reject) => {
        onAbort = () => {
          if (stop) return;
          stop = 'aborted';
          controller.abort();
          reject(new QaError('ABORTED'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          if (stop) return;
          stop = 'timeout';
          controller.abort();
          reject(new QaError('TIMEOUT'));
        }, timeout);
      });
      const stopOf = () => stop;
      const failStop = () => {
        if (stop === 'timeout') throw new QaError('TIMEOUT');
        throw new QaError('ABORTED');
      };

      const operation = (async () => {
        if (signal?.aborted || stop) failStop();
        if (!name || !modelName) throw new QaError('NOT_CONFIGURED');
        let key = '';
        try { key = trimmed(await getApiKey()); }
        catch { throw new QaError('NOT_CONFIGURED'); }
        if (stop || signal?.aborted) failStop();
        if (!key) throw new QaError('NOT_CONFIGURED');
        if (GITHUB_TOKEN.test(key)) throw new QaError('WRONG_CREDENTIAL', undefined, { retryable: false });
        const style = name === 'anthropic' ? 'anthropic' : 'openai';
        const url = name === 'openai-compatible' ? compatibleUrl(baseUrl)
          : name === 'anthropic' ? ANTHROPIC_URL : OPENAI_URL[name];
        if (!url) throw new QaError('NOT_CONFIGURED');
        const messages = [...historyMessages(payload.history), { role: 'user', content: userContent(payload) }];
        const headers = headersFor(style, key);
        let jsonMode = style === 'openai';
        let raw = '';
        let status = 0;
        let ok = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (stop || signal?.aborted) failStop();
          const body = style === 'anthropic' ? anthropicBody(modelName, messages) : openaiBody(modelName, messages, jsonMode);
          const result = await send(fetchImpl, url, headers, body, controller.signal, stopOf);
          raw = result.raw;
          status = result.status;
          ok = result.ok;
          if (ok) break;
          if (attempt === 0 && jsonMode && status === 400 && String(raw).toLowerCase().includes('response_format')) {
            jsonMode = false;
            continue;
          }
          const failure = httpFailure(status, raw);
          if (failure) throw failure;
          if (BALANCE.test(raw)) throw new QaError('NO_BALANCE', undefined, { status });
          throw new QaError('INVALID_RESPONSE');
        }
        if (!ok) throw new QaError('INVALID_RESPONSE');
        let data = null;
        try { data = JSON.parse(raw); }
        catch { data = null; }
        const text = modelOutput(style, data);
        if (!text) {
          if (BALANCE.test(raw)) throw new QaError('NO_BALANCE', undefined, { status });
          throw new QaError('INVALID_RESPONSE');
        }
        return assemble(payload, extractJsonObject(text), name, modelName, now, key);
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

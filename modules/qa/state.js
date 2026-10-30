import { QaError, errorRecord } from './errors.js';

export const LIMITS = Object.freeze({ question: 1000, context: 8000, history: 8, timeout: 30000 });
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const object = value => isObject(value) ? value : {};
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
export const characterCount = value => Array.from(String(value || '')).length;

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item) ?? 'null').join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Copy the source data, never the formatted DOM. Validation happens before a request. */
export function snapshotContext(value) {
  const source = object(value);
  return {
    unit: String(source.unit || ''),
    chunkId: String(source.chunkId || ''),
    blockId: String(source.blockId ?? ''),
    book: String(source.book || ''),
    context: (Array.isArray(source.context) ? source.context : []).map(part => ({
      anchor: String(part?.anchor || ''), kind: String(part?.kind || ''), text: String(part?.text ?? '')
    })),
    ...(source.label ? { label: String(source.label) } : {})
  };
}

export function contextKey(value) {
  const { label, ...context } = snapshotContext(value);
  return stableStringify(context);
}

export function validateRequest(request) {
  const fail = message => { throw new QaError('INVALID_REQUEST', message, { retryable: false }); };
  if (!isObject(request) || request.v !== 1) fail('答疑请求版本无效，请刷新后重试。');
  for (const key of ['requestId', 'threadId', 'unit', 'chunkId', 'blockId', 'book']) {
    if (typeof request[key] !== 'string' || !request[key].trim() || request[key].length > 256)
      fail('当前教材位置不完整，请重新打开该段落。');
  }
  if (request.threadId !== `${request.chunkId}:${request.blockId}`) fail('当前问题与教材段落不一致。');
  if (typeof request.question !== 'string' || !request.question.trim()) fail('请先写下你的问题。');
  if (characterCount(request.question) > LIMITS.question) fail('问题超过 1000 字，请缩短后重试；输入已保留。');
  if (!Array.isArray(request.context) || request.context.length === 0)
    fail('尚未取得当前段落的教材原文，请重新打开该段落。');
  const anchors = new Set();
  for (const part of request.context) {
    if (!isObject(part) || typeof part.anchor !== 'string' || !part.anchor.startsWith(`${request.book}:`)
      || !/^\w+:p\d+:b\d+$/.test(part.anchor) || typeof part.kind !== 'string' || !part.kind
      || typeof part.text !== 'string' || !part.text.trim()) fail('教材上下文缺少可核对的书号、锚点或原文。');
    if (anchors.has(part.anchor)) fail('教材上下文含重复锚点，请重新载入该段落。');
    anchors.add(part.anchor);
  }
  if (request.context.reduce((sum, part) => sum + characterCount(part.text), 0) > LIMITS.context)
    fail('教材上下文超过 8000 字，请缩小到当前段落和必要相邻片段后重试；没有截断教材内容。');
  if (!Array.isArray(request.history) || request.history.length > LIMITS.history
    || request.history.some(message => !isObject(message) || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string')) fail('对话历史格式无效，请重新提问。');
  return request;
}

export function validateResponse(request, response) {
  const fail = code => { throw new QaError(code); };
  if (!isObject(response) || response.v !== 1 || response.requestId !== request.requestId
    || response.threadId !== request.threadId || !['answered', 'insufficient_context'].includes(response.status))
    fail('INVALID_RESPONSE');
  const answer = response.answer;
  if (!isObject(answer) || typeof answer.text !== 'string' || !answer.text.trim()
    || !['教材', '推理'].includes(answer.basis) || typeof answer.by !== 'string' || !answer.by.trim()
    || typeof answer.at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(answer.at)
    || !Number.isFinite(Date.parse(answer.at)) || !Array.isArray(answer.quotes)
    || (response.followUp !== undefined && typeof response.followUp !== 'string')) fail('INVALID_RESPONSE');
  if (response.status === 'answered' && answer.quotes.length === 0) fail('INVALID_CITATION');
  for (const quote of answer.quotes) {
    const original = request.context.find(part => part.anchor === quote?.anchor);
    if (!original || typeof quote.text !== 'string' || !quote.text.trim() || !original.text.includes(quote.text))
      fail('INVALID_CITATION');
  }
  return copy(response);
}

function newer(left, right) {
  if (!left) return right;
  if (!right) return left;
  const delta = number(left.updatedAt) - number(right.updatedAt);
  if (delta) return delta > 0 ? left : right;
  // Same millisecond on two devices: stable tie break, independent of argument order.
  return stableStringify(left) >= stableStringify(right) ? left : right;
}

/** Does not choose record-level removed/note/resolved flags: the host retains its existing rule. */
export function mergeQa(leftQa, rightQa) {
  const left = object(leftQa), right = object(rightQa);
  const lTurns = object(left.turns), rTurns = object(right.turns);
  const ids = [...new Set([...Object.keys(lTurns), ...Object.keys(rTurns)])].sort();
  const turns = Object.fromEntries(ids.flatMap(id => {
    const a = own(lTurns, id) && isObject(lTurns[id]) ? lTurns[id] : undefined;
    const b = own(rTurns, id) && isObject(rTurns[id]) ? rTurns[id] : undefined;
    const winner = newer(a, b);
    return winner ? [[id, { ...copy(winner), requestId: id, updatedAt: number(winner.updatedAt) }]] : [];
  }));
  const draft = newer(isObject(left.draft) ? left.draft : undefined, isObject(right.draft) ? right.draft : undefined);
  return { version: 1, turns, ...(draft ? { draft: { ...copy(draft), updatedAt: number(draft.updatedAt) } } : {}) };
}

function stamp(now, ...previous) {
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) throw new TypeError('now must be a finite numeric timestamp');
  return Math.max(Math.floor(now), ...previous.map(value => number(value) + 1));
}

export function sortedTurns(record) {
  return Object.entries(object(record?.qa?.turns)).filter(([, turn]) => isObject(turn))
    .map(([id, turn]) => ({ ...turn, requestId: id }))
    .sort((a, b) => number(a.createdAt) - number(b.createdAt)
      || (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
}

/** Tombstones stay in sortedTurns so other counts do not change. Callers that draw or prompt skip them. */
export function visibleTurns(record) {
  return sortedTurns(record).filter(turn => !turn.deleted);
}

function sameRecord(record, request) {
  return !!record && isObject(request) && !record.removed
    && (record.chunk === undefined || String(record.chunk) === request.chunkId)
    && (record.block === undefined || String(record.block) === request.blockId)
    && (record.unit === undefined || String(record.unit) === request.unit);
}

function matchesPending(record, request, attemptId) {
  if (!sameRecord(record, request)) return false;
  const turn = record.qa?.turns?.[request.requestId];
  return !!turn && turn.status === 'pending' && turn.threadId === request.threadId
    && turn.contextKey === contextKey(request) && stableStringify(turn.request) === stableStringify(request)
    && (attemptId === undefined || turn.attemptId === attemptId);
}

/** The caller provides now; this is deterministic and never reads clocks or browser state. */
export function updateTurn(record, requestId, patch, now) {
  if (!record || record.removed || !isObject(patch)) return record;
  const previous = record.qa?.turns?.[requestId];
  if (!previous) return record;
  if (patch.request && stableStringify(patch.request) !== stableStringify(previous.request)) return record;
  const updatedAt = stamp(now, record.updatedAt, previous.updatedAt);
  const turn = { ...previous, ...copy(patch), requestId, updatedAt };
  // An explicit undefined removes a stale error/resolution without serializing undefined fields.
  for (const key of Object.keys(patch)) if (patch[key] === undefined) delete turn[key];
  return { ...record, updatedAt, qa: { ...object(record.qa), version: 1,
    turns: { ...object(record.qa?.turns), [requestId]: turn } } };
}

function recordForContext(record, context, now) {
  if (record?.removed) return record;
  if (record && !sameRecord(record, { ...context, threadId: `${context.chunkId}:${context.blockId}` })) return record;
  return { ...object(record), chunk: context.chunkId, block: context.blockId, unit: context.unit,
    note: record?.note ?? '', at: record?.at || new Date(now).toISOString() };
}

export function setDraft(record, context, text, now) {
  const base = recordForContext(record, context, now);
  if (base?.removed || (record && !sameRecord(record, context))) return record;
  const key = contextKey(context);
  if (base.qa?.draft?.text === text && base.qa.draft.contextKey === key) return record || base;
  const updatedAt = stamp(now, base.updatedAt, base.qa?.draft?.updatedAt);
  return { ...base, updatedAt, qa: { ...object(base.qa), version: 1, turns: { ...object(base.qa?.turns) },
    draft: { text: String(text), contextKey: key, updatedAt } } };
}

export function historyFor(record, context) {
  const key = contextKey(context);
  return visibleTurns(record).filter(turn => turn.contextKey === key
    && ['answered', 'insufficient_context'].includes(turn.status) && turn.answer?.text)
    .slice(-LIMITS.history / 2).flatMap(turn => [
      // A reply keeps its framing so the model knows which 再想一步 it answers.
      { role: 'user', content: turn.request?.question || turn.question },
      { role: 'assistant', content: turn.followUp ? `${turn.answer.text}\n再想一步：${turn.followUp}` : turn.answer.text }
    ]);
}

export function createTurn(context, question, record, { requestId, attemptId = requestId, now, replyTo, followUp } = {}) {
  const source = snapshotContext(context);
  const { label, ...apiContext } = source;
  const asked = String(question ?? '').trim();
  if (!asked) throw new QaError('INVALID_REQUEST', '请先写下你的问题。', { retryable: false });
  const requestQuestion = replyTo
    ? `我来回答你上一轮的「再想一步」：${followUp ?? ''}\n我的回答：${asked}`
    : asked;
  const createdAt = stamp(now, record?.updatedAt, ...sortedTurns(record).map(turn => turn.createdAt));
  const request = validateRequest({ v: 1, requestId, threadId: `${source.chunkId}:${source.blockId}`,
    ...apiContext, question: requestQuestion, history: historyFor(record, source) });
  return { requestId, threadId: request.threadId, question: asked,
    ...(replyTo ? { replyTo } : {}),
    contextKey: contextKey(source), request, createdAt, updatedAt: createdAt,
    status: 'pending', attemptId };
}

export function addTurn(record, turn, now) {
  const request = validateRequest(turn.request);
  if (record?.removed || (record && !sameRecord(record, request)) || own(record?.qa?.turns, turn.requestId)) return record;
  const base = recordForContext(record, request, now);
  const updatedAt = stamp(now, base.updatedAt, turn.updatedAt);
  return { ...base, updatedAt, qa: { ...object(base.qa), version: 1,
    turns: { ...object(base.qa?.turns), [turn.requestId]: { ...copy(turn), updatedAt } } } };
}

export function retryTurn(record, requestId, context, now, attemptId) {
  const turn = record?.qa?.turns?.[requestId];
  if (!turn || !sameRecord(record, turn.request) || !['pending', 'error'].includes(turn.status)) return record;
  if (turn.contextKey !== contextKey(context)) throw new QaError('CONTEXT_CHANGED', undefined, { retryable: false });
  return updateTurn(record, requestId, { status: 'pending', error: undefined, attemptId }, now);
}

export function failTurn(record, request, error, now, attemptId) {
  if (!matchesPending(record, request, attemptId)) return record;
  return updateTurn(record, request.requestId, { status: 'error', error: errorRecord(error) }, now);
}

export function applyResponse(record, request, response, now, attemptId) {
  if (!matchesPending(record, request, attemptId)) return record;
  const valid = validateResponse(request, response);
  const next = updateTurn(record, request.requestId, { status: valid.status,
    answer: valid.answer, followUp: valid.followUp || '', error: undefined, resolved: undefined }, now);
  // A late earlier answer belongs to its own turn. It must not replace a newer question's summary or resolution.
  if (visibleTurns(next).at(-1)?.requestId !== request.requestId) return next;
  const summary = { text: valid.answer.text, quote: valid.answer.quotes.map(quote => quote.text).join('\n'),
    by: valid.answer.by, at: valid.answer.at, basis: valid.answer.basis,
    quotes: copy(valid.answer.quotes), status: valid.status, requestId: request.requestId };
  const result = { ...next, answer: summary };
  delete result.resolved;
  return result;
}

export function setResolution(record, requestId, resolved, now) {
  const turn = record?.qa?.turns?.[requestId];
  if (!record || record.removed || !turn || !['answered', 'insufficient_context'].includes(turn.status)
    || !['got', 'still'].includes(resolved)) return record;
  const next = updateTurn(record, requestId, { resolved }, now);
  if (visibleTurns(next).at(-1)?.requestId === requestId) next.resolved = resolved;
  return next;
}

function answerSummary(turn) {
  const answer = turn.answer || {};
  const quotes = Array.isArray(answer.quotes) ? answer.quotes : [];
  return {
    text: answer.text, quote: quotes.map(item => item.text).join('\n'),
    by: answer.by, at: answer.at, basis: answer.basis,
    quotes: copy(quotes), status: turn.status, requestId: turn.requestId
  };
}

function idsToDelete(record, requestId) {
  const turns = sortedTurns(record);
  const ids = [];
  const queue = [requestId];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const turn = record?.qa?.turns?.[id];
    if (!isObject(turn) || turn.deleted) continue;
    ids.push(id);
    for (const candidate of turns) {
      if (candidate.replyTo === id && !candidate.deleted) queue.push(candidate.requestId);
    }
  }
  return ids;
}

function tombstone(turn, updatedAt) {
  return {
    requestId: turn.requestId, threadId: turn.threadId, contextKey: turn.contextKey,
    createdAt: turn.createdAt, deleted: true, updatedAt
  };
}

function reconcileSummary(record, ids) {
  if (!record.answer?.requestId || !ids.has(record.answer.requestId)) return record;
  const last = visibleTurns(record).filter(turn =>
    ['answered', 'insufficient_context'].includes(turn.status) && turn.answer?.text).at(-1);
  if (!last) {
    const result = { ...record };
    delete result.answer;
    delete result.resolved;
    return result;
  }
  const result = { ...record, answer: answerSummary(last) };
  if (last.resolved === 'got' || last.resolved === 'still') result.resolved = last.resolved;
  else delete result.resolved;
  return result;
}

/** Replace one turn, and replies hanging under it, with syncable tombstones. Content is dropped. */
export function deleteTurn(record, requestId, now) {
  if (!record || record.removed) return record;
  const ids = idsToDelete(record, requestId);
  if (!ids.length) return record;
  let next = record;
  for (const id of ids) {
    const turn = next.qa?.turns?.[id];
    if (!isObject(turn) || turn.deleted) continue;
    const stamped = updateTurn(next, id, { deleted: true }, now);
    if (stamped === next) continue;
    const updatedAt = stamped.qa.turns[id].updatedAt;
    next = { ...stamped, qa: { ...stamped.qa, turns: { ...stamped.qa.turns, [id]: tombstone(turn, updatedAt) } } };
  }
  return reconcileSummary(next, new Set(ids.filter(id => next.qa?.turns?.[id]?.deleted)));
}

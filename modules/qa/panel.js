import { createClient } from './client.js';
import { QaError, errorRecord } from './errors.js';
import { LIMITS, characterCount, snapshotContext, contextKey, sortedTurns, visibleTurns, createTurn, addTurn,
  setDraft, retryTurn, failTurn, applyResponse, setResolution, deleteTurn } from './state.js';

const mounts = new WeakMap();
let panelSequence = 0;
const uuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new QaError('UNAVAILABLE');
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

function buildThreads(turns) {
  const byId = new Map(turns.map(turn => [turn.requestId, turn]));
  const children = new Map();
  const roots = [];
  for (const turn of turns) {
    if (turn.replyTo && byId.has(turn.replyTo)) {
      const list = children.get(turn.replyTo) || [];
      list.push(turn);
      children.set(turn.replyTo, list);
    } else roots.push(turn);
  }
  const flatten = (turn, depth, acc) => {
    acc.push({ turn, depth });
    for (const child of children.get(turn.requestId) || []) flatten(child, depth + 1, acc);
    return acc;
  };
  return roots.map(root => {
    const nodes = flatten(root, 0, []);
    return { root, nodes, turns: nodes.map(node => node.turn) };
  });
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
    if (!turn || turn.deleted) continue;
    ids.push(id);
    for (const candidate of turns) {
      if (candidate.replyTo === id && !candidate.deleted) queue.push(candidate.requestId);
    }
  }
  return ids;
}

/**
 * saveRecord(update) must atomically invoke update(getRecord()) and commit locally before returning.
 * It may start a background repository sync, but must not wait for that network before committing.
 * update returning the same record or undefined means no write. The host must preserve full records.
 */
export function mountPanel({ root, context, getRecord, saveRecord, client = createClient() }) {
  if (!root?.ownerDocument || typeof getRecord !== 'function' || typeof saveRecord !== 'function')
    throw new TypeError('mountPanel requires a DOM root, getRecord(), and saveRecord(update)');
  mounts.get(root)?.destroy();
  const doc = root.ownerDocument;
  let current = snapshotContext(context), epoch = 0, disposed = false, notice = '', noticeError = false;
  const pending = new Map();
  const replies = new Map();
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const button = (text, action, requestId, extra = {}) => {
    const node = element('button', 'qa-button qa-button-secondary', text);
    node.type = 'button'; node.dataset.qaAction = action;
    if (requestId) node.dataset.requestId = requestId;
    Object.assign(node.dataset, extra);
    return node;
  };
  const wrapper = element('section', 'qa-content');
  wrapper.setAttribute('aria-label', '答疑');
  panelSequence += 1;
  const turnsHost = element('div', 'qa-turns');
  const status = element('p', 'qa-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const form = element('form', 'qa-form');
  const input = element('textarea', 'qa-input'); input.id = `qa-input-${panelSequence}`; input.rows = 1;
  input.placeholder = '问点什么';
  input.setAttribute('aria-label', '问点什么');
  const send = element('button', 'qa-button qa-button-primary', '问');
  send.type = 'submit';
  const count = element('span', 'qa-count'); count.setAttribute('aria-live', 'off');
  form.append(input, send, count);
  wrapper.append(turnsHost, status, form);
  root.classList.add('qa-panel'); root.replaceChildren(wrapper);
  const threadId = () => `${current.chunkId}:${current.blockId}`;

  function read() {
    const record = getRecord();
    if (record && ((record.chunk !== undefined && String(record.chunk) !== current.chunkId)
      || (record.block !== undefined && String(record.block) !== current.blockId))) return undefined;
    return record;
  }
  function commit(update) {
    const result = saveRecord(update);
    if (result?.then) throw new QaError('SAVE_FAILED');
    return read();
  }
  function flash(message, isError = false) { notice = message; noticeError = isError; }
  function updateCounter() {
    const length = characterCount(input.value);
    count.hidden = length <= 900;
    count.textContent = `剩余 ${LIMITS.question - length} 字`;
    input.style.height = 'auto';
    input.style.height = `${Math.min(164, Math.max(44, input.scrollHeight + 2))}px`;
    count.classList.toggle('qa-over-limit', length > LIMITS.question);
    input.setAttribute('aria-invalid', length > LIMITS.question ? 'true' : 'false');
  }
  function populateDraft() {
    const draft = read()?.qa?.draft;
    input.value = draft?.contextKey === contextKey(current) ? String(draft.text || '') : '';
    updateCounter();
  }
  function saveInput() {
    if (disposed) return;
    try {
      const now = Date.now();
      commit(latest => setDraft(latest, current, input.value, now));
    } catch {
      flash('输入暂未成功保存，请重试。', true); render();
    }
    updateCounter();
  }
  function abortPending() {
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear();
  }
  function focusReply(requestId) {
    turnsHost.querySelector(`[data-reply-for="${CSS.escape(requestId)}"]`)?.focus();
  }
  function syncComposer(removed) {
    input.disabled = removed;
    send.disabled = removed;
  }
  function appendQuote(host, quote, index, turn) {
    const block = element('blockquote', 'qa-quote');
    block.append(element('p', 'qa-quote-text', quote.text), element('cite', 'qa-anchor', quote.anchor));
    const ask = button('围绕这句追问', 'quote', turn.requestId, { quoteIndex: String(index) });
    ask.disabled = turn.contextKey !== contextKey(current);
    if (ask.disabled) ask.title = '引用来自此前教材上下文，请按当前片段重新提问。';
    block.append(ask);
    host.append(block);
  }

  function renderAnswer(host, answer, turn, repliedIds) {
    const insufficient = turn.status === 'insufficient_context';
    host.append(element('p', 'qa-answer-text', answer.text));
    if (typeof answer.imageNote === 'string' && answer.imageNote)
      host.append(element('p', 'qa-image-note', answer.imageNote));
    // The synthetic sentence is only there so an answered turn can be saved. It is not the user's quote.
    const quotes = answer.fallbackQuote === true ? [] : (answer.quotes || []);
    quotes.slice(0, 1).forEach((quote, index) => appendQuote(host, quote, index, turn));
    if (quotes.length > 1) {
      const more = element('details', 'qa-more-quotes');
      const summary = element('summary', 'qa-more-summary', `另外 ${quotes.length - 1} 处原文`);
      more.append(summary);
      quotes.slice(1).forEach((quote, index) => appendQuote(more, quote, index + 1, turn));
      host.append(more);
    }
    if (insufficient) host.append(element('p', 'qa-insufficient', '当前资料不足以证实结论，请按回答提示补充教材片段后再问。'));
    if (turn.followUp) {
      const follow = element('div', 'qa-follow-up');
      follow.append(element('p', '', `再想一步：${turn.followUp}`));
      const answered = repliedIds.has(turn.requestId);
      if (!answered) follow.append(button('我来答', 'answer-follow', turn.requestId));
      const draft = replies.get(turn.requestId);
      if (!answered && draft?.open) {
        const compose = element('div', 'qa-reply-compose');
        const area = element('textarea', 'qa-reply-input');
        area.rows = 2;
        area.value = draft.text || '';
        area.dataset.replyFor = turn.requestId;
        area.setAttribute('aria-label', '回答再想一步');
        const actions = element('div', 'qa-reply-actions');
        const submitReply = button('提交', 'submit-reply', turn.requestId);
        submitReply.classList.add('qa-button-primary');
        actions.append(submitReply, button('取消', 'cancel-reply', turn.requestId));
        compose.append(area, actions);
        follow.append(compose);
      }
      host.append(follow);
    }
    const meta = [answer.by ? `回答来源：${answer.by}` : '', answer.at ? `时间：${answer.at}` : ''].filter(Boolean).join(' · ');
    if (meta) host.append(element('p', 'qa-answer-meta', meta));
    if (!insufficient) {
      const actions = element('div', 'qa-resolution');
      const got = button(turn.resolved === 'got' ? '已标记：懂了' : '懂了', 'got', turn.requestId);
      const still = button(turn.resolved === 'still' ? '已标记：还是不懂' : '还是不懂', 'still', turn.requestId);
      got.setAttribute('aria-pressed', turn.resolved === 'got' ? 'true' : 'false');
      still.setAttribute('aria-pressed', turn.resolved === 'still' ? 'true' : 'false');
      actions.append(got, still); host.append(actions);
      if (turn.resolved === 'still') host.append(element('p', 'qa-still-hint', '回答保留在这里。可以把仍不明白的地方写成下一问。'));
    }
  }

  function renderTurn(turn, depth, repliedIds) {
    const item = element('article', 'qa-turn');
    item.dataset.requestId = turn.requestId;
    if (depth > 0) {
      item.classList.add('qa-reply');
      item.dataset.depth = String(Math.min(depth, 2));
    }
    const head = element('div', 'qa-turn-head');
    const remove = element('button', 'qa-delete', '删除');
    remove.type = 'button';
    remove.dataset.qaAction = 'delete';
    remove.dataset.requestId = turn.requestId;
    head.append(remove);
    item.append(head, element('p', 'qa-question', turn.question ?? ''));
    const sameContext = turn.contextKey === contextKey(current);
    if (!sameContext) item.append(element('p', 'qa-old-context', '来自此前教材上下文'));
    if (['answered', 'insufficient_context'].includes(turn.status) && turn.answer) renderAnswer(item, turn.answer, turn, repliedIds);
    else if (turn.status === 'pending') {
      const isRunning = pending.has(turn.requestId);
      item.append(element('p', 'qa-waiting', isRunning ? '问题已保存 · 正在回答…' : '问题已保存，上次等待已中断。'));
      if (!isRunning) item.append(button(sameContext ? '继续请求' : '带入问题重新提问', sameContext ? 'retry' : 'copy', turn.requestId));
    } else if (turn.status === 'error') {
      const error = element('p', 'qa-error', turn.error?.code === 'NOT_CONFIGURED' ? '还没设置模型，问题已存下' : turn.error?.message || '请求未完成，问题已保留。');
      error.setAttribute('role', 'note'); item.append(error);
      if (turn.error?.code === 'NOT_CONFIGURED') { error.className = 'qa-waiting'; return item; }
      item.append(element('p', 'qa-answer-meta', `状态 ${turn.error?.status || '—'} · ${turn.error?.code || 'ERROR'}${turn.error?.finish_reason ? ` · ${turn.error.finish_reason}` : ''}`));
      if (!sameContext) item.append(button('带入问题重新提问', 'copy', turn.requestId));
      else if (turn.error?.retryable !== false) item.append(button('重试这个问题', 'retry', turn.requestId));
      else item.append(button('带入输入框修改', 'copy', turn.requestId));
    }
    return item;
  }

  function render() {
    if (disposed) return;
    const focusedReply = doc.activeElement?.dataset?.replyFor || '';
    const caret = focusedReply ? doc.activeElement.selectionStart : 0;
    if (focusedReply) replies.set(focusedReply, { open: true, text: doc.activeElement.value });
    const record = read();
    const removed = !!record?.removed;
    const turns = visibleTurns(record).filter(turn => turn.threadId === threadId());
    const threads = buildThreads(turns);
    const repliedIds = new Set(turns.filter(turn => turn.replyTo).map(turn => turn.replyTo));
    const children = [];
    if (removed) {
      abortPending();
      children.push(element('p', 'qa-removed', '这条疑问已移除。'));
    } else {
      const summaryShown = turns.some(turn => turn.answer && (record?.answer?.requestId === turn.requestId
        || record?.answer?.text === turn.answer.text));
      if (record?.answer && !summaryShown && (record.answer.text || record.answer.quote)
        && (!record.answer.requestId || turns.some(turn => turn.requestId === record.answer.requestId))) {
        const legacy = element('article', 'qa-turn qa-legacy');
        legacy.append(element('p', 'qa-answer-text', record.answer.text || ''));
        if (record.answer.quote) legacy.append(element('blockquote', 'qa-quote', record.answer.quote));
        if (record.answer.by || record.answer.at) legacy.append(element('p', 'qa-answer-meta',
          [record.answer.by, record.answer.at].filter(Boolean).join(' · ')));
        children.push(legacy);
      }
      for (const thread of threads) {
        const body = element('div', 'qa-thread');
        for (const node of thread.nodes) body.append(renderTurn(node.turn, node.depth, repliedIds));
        children.push(body);
      }
    }
    turnsHost.replaceChildren(...children);
    status.textContent = notice || (pending.size ? '问题已保存，正在请求回答。你可以继续写下一问。' : '');
    status.classList.toggle('qa-error', noticeError);
    syncComposer(removed);
    if (focusedReply) {
      const area = turnsHost.querySelector(`[data-reply-for="${CSS.escape(focusedReply)}"]`);
      if (area) {
        area.focus();
        const pos = Math.min(caret ?? area.value.length, area.value.length);
        try { area.setSelectionRange(pos, pos); } catch { /* selection is optional while detached */ }
      }
    }
  }

  async function requestTurn(turn) {
    if (disposed || pending.has(turn.requestId)) return;
    const generation = epoch, key = contextKey(current), controller = new AbortController();
    pending.set(turn.requestId, { controller, generation });
    flash(''); render();
    try {
      const response = await client.answer(turn.request, { signal: controller.signal });
      if (disposed || generation !== epoch || key !== contextKey(current)) return;
      commit(latest => applyResponse(latest, turn.request, response, Date.now(), turn.attemptId));
    } catch (error) {
      if (disposed || generation !== epoch || key !== contextKey(current)) return;
      try {
        commit(latest => failTurn(latest, turn.request, error, Date.now(), turn.attemptId));
      } catch { flash('回答状态暂未成功保存。原问题仍在，请稍后重试。', true); }
    } finally {
      if (pending.get(turn.requestId)?.controller === controller) pending.delete(turn.requestId);
      if (!disposed && generation === epoch) render();
    }
  }

  function submit(event) {
    event?.preventDefault();
    if (disposed) return;
    const question = input.value;
    try {
      const requestId = uuid(), attemptId = uuid(), now = Date.now();
      const saved = commit(latest => {
        if (latest?.removed) return latest;
        const turn = createTurn(current, question, latest, { requestId, attemptId, now });
        const next = addTurn(latest, turn, now);
        return next === latest ? latest : setDraft(next, current, '', now);
      });
      const turn = saved?.qa?.turns?.[requestId];
      if (!turn || saved.removed) throw new QaError(saved?.removed ? 'REMOVED' : 'SAVE_FAILED');
      input.value = '';
      updateCounter();
      void requestTurn(turn);
    } catch (error) {
      const failure = errorRecord(error instanceof QaError ? error : new QaError('SAVE_FAILED'));
      flash(failure.message, true); render(); input.focus();
    }
  }

  function submitReply(requestId) {
    const area = turnsHost.querySelector(`[data-reply-for="${CSS.escape(requestId)}"]`);
    const question = area ? area.value : (replies.get(requestId)?.text || '');
    replies.set(requestId, { open: true, text: question });
    try {
      const newId = uuid(), attemptId = uuid(), now = Date.now();
      const saved = commit(latest => {
        if (latest?.removed) return latest;
        const parent = latest?.qa?.turns?.[requestId];
        if (!parent || parent.deleted || !parent.followUp) return latest;
        const created = createTurn(current, question, latest, {
          requestId: newId, attemptId, now, replyTo: requestId, followUp: parent.followUp
        });
        return addTurn(latest, created, now);
      });
      const created = saved?.qa?.turns?.[newId];
      if (!created || saved.removed) throw new QaError(saved?.removed ? 'REMOVED' : 'SAVE_FAILED');
      replies.delete(requestId);
      void requestTurn(created);
    } catch (error) {
      const failure = errorRecord(error instanceof QaError ? error : new QaError('SAVE_FAILED'));
      flash(failure.message, true);
      render();
      focusReply(requestId);
    }
  }

  function actions(event) {
    const target = event.target.closest?.('[data-qa-action]');
    if (!target || !root.contains(target) || target.disabled || disposed) return;
    const action = target.dataset.qaAction, requestId = target.dataset.requestId;
    const record = read(), turn = record?.qa?.turns?.[requestId];
    if (action === 'delete') {
      if (record?.removed || !turn || turn.deleted) { render(); return; }
      if (!doc.defaultView.confirm('删除这一问和它的回答？')) return;
      try {
        for (const id of idsToDelete(record, requestId)) {
          replies.delete(id);
          const entry = pending.get(id);
          if (!entry) continue;
          entry.controller.abort();
          pending.delete(id);
        }
        commit(latest => deleteTurn(latest, requestId, Date.now()));
        notice = '';
        noticeError = false;
        render();
      } catch (error) { flash(errorRecord(error).message, true); render(); }
      return;
    }
    if (record?.removed || !turn || turn.deleted) { render(); return; }
    try {
      if (action === 'retry') {
        if (pending.has(requestId)) return;
        const saved = commit(latest => retryTurn(latest, requestId, current, Date.now(), uuid()));
        const next = saved?.qa?.turns?.[requestId];
        if (next?.status === 'pending' && !saved.removed) void requestTurn(next);
      } else if (action === 'got' || action === 'still') {
        commit(latest => setResolution(latest, requestId, action, Date.now()));
        flash(action === 'got' ? '已标记为懂了。' : '已记录：还是不懂。可以继续追问。');
        render();
      } else if (action === 'answer-follow') {
        if (!turn.followUp || visibleTurns(record).some(item => item.replyTo === requestId)) return;
        replies.set(requestId, { open: true, text: replies.get(requestId)?.text || '' });
        render();
        focusReply(requestId);
      } else if (action === 'cancel-reply') {
        replies.delete(requestId);
        render();
      } else if (action === 'submit-reply') {
        submitReply(requestId);
      } else if (action === 'copy' || action === 'quote') {
        if (action === 'copy') input.value = turn.question || '';
        else {
          const quote = turn.answer?.quotes?.[Number(target.dataset.quoteIndex)];
          if (!quote || turn.contextKey !== contextKey(current)) return;
          const prefix = `关于 ${quote.anchor} 这句原文，我想问：`;
          input.value = input.value.trim() ? `${input.value}\n${prefix}` : prefix;
        }
        saveInput();
        flash('继续写下你的问题，提交后会作为新的一轮保存。');
        render();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } catch (error) { flash(errorRecord(error).message, true); render(); }
  }

  function onReplyInput(event) {
    const area = event.target;
    if (!area?.dataset?.replyFor || disposed) return;
    replies.set(area.dataset.replyFor, { open: true, text: area.value });
  }

  form.addEventListener('submit', submit);
  input.addEventListener('input', saveInput);
  root.addEventListener('click', actions);
  root.addEventListener('input', onReplyInput);
  const controller = {
    refresh() {
      if (disposed) return;
      if (doc.activeElement !== input) populateDraft();
      render();
    },
    setContext(nextContext) {
      if (disposed) return;
      const next = snapshotContext(nextContext);
      if (contextKey(next) !== contextKey(current)) {
        epoch += 1; abortPending(); notice = ''; noticeError = false;
        replies.clear();
      }
      current = next; populateDraft(); render();
    },
    ask(text) {
      if (disposed) return;
      const question = String(text ?? '').trim();
      if (!question) return;
      input.value = question;
      submit();
    },
    destroy() {
      if (disposed) return;
      disposed = true; epoch += 1; abortPending();
      form.removeEventListener('submit', submit); input.removeEventListener('input', saveInput);
      root.removeEventListener('click', actions); root.removeEventListener('input', onReplyInput);
      if (mounts.get(root) === controller) {
        mounts.delete(root); root.classList.remove('qa-panel');
        if (wrapper.parentNode === root) root.replaceChildren();
      }
    }
  };
  mounts.set(root, controller);
  populateDraft(); render();
  return controller;
}

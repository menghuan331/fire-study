import { createClient } from './client.js';
import { QaError, errorRecord } from './errors.js';
import { LIMITS, characterCount, snapshotContext, contextKey, sortedTurns, createTurn, addTurn,
  setDraft, retryTurn, failTurn, applyResponse, setResolution } from './state.js';

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
  const headingId = `qa-title-${++panelSequence}`;
  wrapper.setAttribute('aria-labelledby', headingId);
  const heading = element('h4', 'qa-heading', '即时答疑'); heading.id = headingId;
  const sourceLabel = element('p', 'qa-source');
  const configHint = element('p', 'qa-config-hint', '答疑服务尚未接通。可以先保存问题，配置后再请求回答。');
  configHint.hidden = client.configured !== false;
  const turnsHost = element('div', 'qa-turns');
  const status = element('p', 'qa-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const form = element('form', 'qa-form');
  const inputId = `qa-input-${panelSequence}`;
  const label = element('label', 'qa-input-label', '你的问题或追问'); label.htmlFor = inputId;
  const input = element('textarea', 'qa-input'); input.id = inputId; input.rows = 3;
  input.placeholder = '写下哪里没看懂，也可以围绕回答继续追问。';
  const hintId = `${inputId}-hint`;
  const hint = element('p', 'qa-input-hint'); hint.id = hintId;
  input.setAttribute('aria-describedby', hintId);
  const controls = element('div', 'qa-controls');
  const send = element('button', 'qa-button qa-button-primary', client.configured === false ? '保存问题' : '保存并提问');
  send.type = 'submit';
  const count = element('span', 'qa-count'); count.setAttribute('aria-live', 'off');
  controls.append(send, count);
  form.append(label, input, hint, controls);
  wrapper.append(heading, sourceLabel, configHint, turnsHost, status, form);
  root.classList.add('qa-panel'); root.replaceChildren(wrapper);

  function read() { return getRecord(); }
  function commit(update) {
    const result = saveRecord(update);
    if (result?.then) throw new QaError('SAVE_FAILED');
    return read();
  }
  function flash(message, isError = false) { notice = message; noticeError = isError; }
  function updateCounter() {
    const length = characterCount(input.value);
    count.textContent = `${length} / ${LIMITS.question} 字`;
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
      hint.textContent = '输入已在本机保存。最多 1000 字；回答后可继续追问。';
    } catch {
      hint.textContent = '输入暂未成功保存。请保留当前页面，重试保存后再发送。';
    }
    updateCounter();
  }
  function abortPending() {
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear();
  }

  function renderAnswer(host, answer, turn) {
    const insufficient = turn.status === 'insufficient_context';
    const badge = element('span', `qa-badge${insufficient ? ' qa-badge-warning' : ''}`,
      insufficient ? '资料不足 · 尚不能确认' : answer.basis === '推理' ? '推理说明' : '教材依据');
    host.append(badge, element('p', 'qa-answer-text', answer.text));
    for (const [index, quote] of (answer.quotes || []).entries()) {
      const block = element('blockquote', 'qa-quote');
      block.append(element('p', 'qa-quote-text', quote.text), element('cite', 'qa-anchor', quote.anchor));
      const ask = button('围绕这句追问', 'quote', turn.requestId, { quoteIndex: String(index) });
      ask.disabled = turn.contextKey !== contextKey(current);
      if (ask.disabled) ask.title = '引用来自此前教材上下文，请按当前片段重新提问。';
      block.append(ask); host.append(block);
    }
    if (insufficient) host.append(element('p', 'qa-insufficient', '当前资料不足以证实结论，请按回答提示补充教材片段后再问。'));
    if (turn.followUp) {
      const follow = element('div', 'qa-follow-up');
      follow.append(element('p', '', `再想一步：${turn.followUp}`), button('继续追问', 'follow', turn.requestId));
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

  function render() {
    if (disposed) return;
    const record = read();
    const removed = !!record?.removed;
    const turns = sortedTurns(record).filter(turn => turn.threadId === `${current.chunkId}:${current.blockId}`);
    sourceLabel.textContent = current.label || `${current.book} · ${current.chunkId} · 段 ${current.blockId}`;
    input.disabled = removed; send.disabled = removed;
    hint.textContent = removed ? '重新标记该段落后可以继续提问。' : '输入自动保存到本机。最多 1000 字；回答后可继续追问。';
    const children = [];
    if (removed) {
      abortPending();
      children.push(element('p', 'qa-removed', '这条疑问已移除。'));
    } else {
      const summaryShown = turns.some(turn => turn.answer && (record?.answer?.requestId === turn.requestId
        || record?.answer?.text === turn.answer.text));
      if (record?.answer && !summaryShown && (record.answer.text || record.answer.quote)) {
        const legacy = element('article', 'qa-turn qa-legacy');
        legacy.append(element('h5', 'qa-turn-heading', '历史回答'),
          element('p', 'qa-answer-text', record.answer.text || ''),
          element('p', 'qa-legacy-note', '原有回答已保留。完整依据和对话以新提问的记录为准。'));
        if (record.answer.quote) legacy.append(element('blockquote', 'qa-quote', record.answer.quote));
        if (record.answer.by || record.answer.at) legacy.append(element('p', 'qa-answer-meta',
          [record.answer.by, record.answer.at].filter(Boolean).join(' · ')));
        children.push(legacy);
      }
      for (const turn of turns) {
        const item = element('article', 'qa-turn'); item.dataset.requestId = turn.requestId;
        item.append(element('h5', 'qa-turn-heading', '你问'), element('p', 'qa-question', turn.question));
        const sameContext = turn.contextKey === contextKey(current);
        if (!sameContext) item.append(element('p', 'qa-old-context', '来自此前教材上下文'));
        if (['answered', 'insufficient_context'].includes(turn.status) && turn.answer) renderAnswer(item, turn.answer, turn);
        else if (turn.status === 'pending') {
          const isRunning = pending.has(turn.requestId);
          item.append(element('p', 'qa-waiting', isRunning ? '问题已保存 · 正在回答…' : '问题已保存，上次等待已中断。'));
          if (!isRunning) item.append(button(sameContext ? '继续请求' : '带入问题重新提问', sameContext ? 'retry' : 'copy', turn.requestId));
        } else if (turn.status === 'error') {
          const error = element('p', 'qa-error', turn.error?.message || '请求未完成，问题已保留。');
          error.setAttribute('role', 'note'); item.append(error);
          if (!sameContext) item.append(button('带入问题重新提问', 'copy', turn.requestId));
          else if (turn.error?.retryable !== false) item.append(button('重试这个问题', 'retry', turn.requestId));
          else item.append(button('带入输入框修改', 'copy', turn.requestId));
        }
        children.push(item);
      }
      if (!turns.length && !record?.answer) children.push(element('p', 'qa-empty', '围绕当前教材原文提问，回答会保存在这里。'));
    }
    turnsHost.replaceChildren(...children);
    status.textContent = notice || (pending.size ? '问题已保存，正在请求回答。你可以继续写下一问。' : '');
    status.classList.toggle('qa-error', noticeError);
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
      input.value = ''; updateCounter();
      void requestTurn(turn);
    } catch (error) {
      const failure = errorRecord(error instanceof QaError ? error : new QaError('SAVE_FAILED'));
      flash(failure.message, true); render(); input.focus();
    }
  }

  function actions(event) {
    const target = event.target.closest?.('[data-qa-action]');
    if (!target || !root.contains(target) || target.disabled || disposed) return;
    const action = target.dataset.qaAction, requestId = target.dataset.requestId;
    const record = read(), turn = record?.qa?.turns?.[requestId];
    if (record?.removed || !turn) { render(); return; }
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
        if (action === 'still') input.focus();
      } else {
        if (action === 'copy') input.value = turn.question;
        else if (action === 'quote') {
          const quote = turn.answer?.quotes?.[Number(target.dataset.quoteIndex)];
          if (!quote || turn.contextKey !== contextKey(current)) return;
          const prefix = `关于 ${quote.anchor} 这句原文，我想问：`;
          input.value = input.value.trim() ? `${input.value}\n${prefix}` : prefix;
        }
        // Following up does not overwrite an unfinished draft.
        saveInput(); flash('继续写下你的问题，提交后会作为新的一轮保存。'); render(); input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } catch (error) { flash(errorRecord(error).message, true); render(); }
  }

  form.addEventListener('submit', submit);
  input.addEventListener('input', saveInput);
  root.addEventListener('click', actions);
  const controller = {
    refresh() {
      if (disposed) return;
      if (doc.activeElement !== input) populateDraft();
      render();
    },
    setContext(nextContext) {
      if (disposed) return;
      const next = snapshotContext(nextContext);
      if (contextKey(next) !== contextKey(current)) { epoch += 1; abortPending(); notice = ''; noticeError = false; }
      current = next; populateDraft(); render();
    },
    destroy() {
      if (disposed) return;
      disposed = true; epoch += 1; abortPending();
      form.removeEventListener('submit', submit); input.removeEventListener('input', saveInput);
      root.removeEventListener('click', actions);
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

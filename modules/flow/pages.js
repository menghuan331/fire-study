export const PAGE_CHAR_LIMIT = 450;
const HEADINGS = new Set(["bold", "h4", "h5", "h6", "fixed"]);
const SOLO = new Set(["figure", "table", "equation"]);

export function plainText(md) {
  return String(md || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]+\$/g, " ")
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function charCount(block) {
  return Array.from(plainText(block && block.md).replace(/\s/g, "")).length;
}

function isFigureCaption(block) {
  if (!block || (block.kind || "para") !== "para") return false;
  return /^图\s*\d/.test(plainText(block.md));
}

function headingsOnly(blocks) {
  return blocks.length > 0 && blocks.every((block) => HEADINGS.has(block.kind || ""));
}

function pageKind(blocks) {
  const solos = blocks.filter((block) => SOLO.has(block.kind));
  if (solos.length !== 1) return "text";
  const solo = solos[0];
  if (solo.kind === "equation") return "equation";
  const restOk = blocks.every((block) => (
    block === solo
    || HEADINGS.has(block.kind || "")
    || (solo.kind === "figure" && isFigureCaption(block))
  ));
  return restOk ? solo.kind : "text";
}

function emitPage(pages, blocks) {
  if (!blocks.length) return;
  pages.push({
    id: `p${blocks[0].id}`,
    blockIds: blocks.map((block) => block.id),
    kind: pageKind(blocks)
  });
}

// Style and consecutive numbers identify a list; a new (1) starts another list.
export function listMarker(block) {
  if (!block || (block.kind || "para") !== "para") return null;
  const text = plainText(block.md).normalize("NFKC");
  const circled = String(block.md || "").replace(/^[\s*_]+/, "").match(/^([①-⑳])/);
  if (circled) return { style: "circle", number: circled[1].codePointAt(0) - 0x2460 + 1 };
  const match = /^(?:\((\d+)\)|(\d+)\.(?!\d))/.exec(text);
  return match ? { style: match[1] ? "paren" : "dot", number: Number(match[1] || match[2]) } : null;
}

function sameList(a, b) {
  const left = listMarker(a), right = listMarker(b);
  return left && right && left.style === right.style && right.number === left.number + 1;
}

function keepListTails(pages, blocks) {
  const byId = new Map(blocks.map((block, index) => [block.id, index]));
  const groups = pages.map(page => page.blockIds.map(id => blocks[byId.get(id)]));
  for (let i = 1; i < groups.length; i++) {
    const prev = groups[i - 1], next = groups[i];
    const tail = next[0], at = byId.get(tail?.id);
    if (!sameList(prev.at(-1), tail) || sameList(tail, blocks[at + 1])) continue;
    const combined = prev.reduce((sum, block) => sum + charCount(block), 0) + charCount(tail);
    // Small overruns are preferable to an orphan; otherwise keep the last pair together.
    // Never detach a formula's introduction from its equation/definitions.
    if (!next.some(block => block.kind === "equation") &&
        (combined <= PAGE_CHAR_LIMIT + 90 || headingsOnly(prev.slice(0, -1)) || prev.length === 1)) {
      prev.push(next.shift());
      if (!next.length) { groups.splice(i, 1); i--; }
    } else {
      next.unshift(prev.pop());
      if (headingsOnly(prev)) next.unshift(...prev.splice(0));
      if (!prev.length) { groups.splice(i - 1, 1); i--; }
    }
  }
  const result = [];
  for (const group of groups) emitPage(result, group);
  return result;
}

/**
 * One block, one place, original order. Page ids stay stable for the same blocks.
 * Consecutive headings share a page and keep the following body.
 * A heading run that sits directly on a figure, table, or equation stays at the top of that page.
 * A paragraph that starts with a figure number stays with the figure before it.
 * A page of only headings is allowed only when the chunk ends there.
 */
export function paginateBlocks(blocks) {
  const pages = [];
  const list = blocks || [];
  let buf = [];
  let chars = 0;
  const flush = () => {
    emitPage(pages, buf);
    buf = [];
    chars = 0;
  };
  for (let index = 0; index < list.length; index += 1) {
    const block = list[index];
    const kind = block && block.kind || "para";
    if (kind === "equation") {
      // Keep the preceding introduction and the complete definition run together.
      const lead = buf.at(-1);
      if (lead && (lead.kind || "para") === "para") {
        buf.pop();
        if (buf.length && !headingsOnly(buf)) flush();
        buf.push(lead);
      } else if (buf.length && !headingsOnly(buf)) flush();
      buf.push(block);
      if (/^式中/.test(plainText(list[index + 1]?.md))) {
        do {
          buf.push(list[++index]);
        } while (list[index + 1]?.kind === "para" &&
          /^(?:式中|[A-Za-z\u0370-\u03ff]|\$|[—－])/.test(String(list[index + 1].md).trim()));
      }
      flush();
      continue;
    }
    if (SOLO.has(kind)) {
      if (buf.length && !headingsOnly(buf)) flush();
      buf.push(block);
      if (kind === "figure" && isFigureCaption(list[index + 1])) {
        buf.push(list[++index]);
      }
      flush();
      continue;
    }
    if (HEADINGS.has(kind)) {
      if (buf.length && !headingsOnly(buf)) flush();
      buf.push(block);
      chars += charCount(block);
      continue;
    }
    const add = charCount(block);
    if (buf.length && kind === "para" && !headingsOnly(buf) && chars + add > PAGE_CHAR_LIMIT) {
      flush();
      buf = [block];
      chars = add;
      continue;
    }
    buf.push(block);
    chars += add;
  }
  flush();
  return keepListTails(pages, list);
}

function anchorBlockId(anchor) {
  const matched = String(anchor || "").match(/b(\d+)\s*$/);
  return matched ? matched[1] : "";
}

function pageByBlock(pages) {
  const map = new Map();
  for (const page of pages || []) {
    for (const id of page.blockIds || []) map.set(String(id), page.id);
  }
  return map;
}

function asMap(questionsById) {
  if (questionsById instanceof Map) return questionsById;
  return new Map(Object.entries(questionsById || {}));
}

/**
 * Hang recog items on the page that owns anchor b<id>.
 * Exam questions use verify.anchor, then anchor. A usable block in this chunk follows that page; otherwise the chunk end.
 */
export function questionsForChunk(chunk, kaokaoItems, questionsById) {
  const pages = paginateBlocks(chunk && chunk.blocks);
  const locate = pageByBlock(pages);
  const questions = [];
  for (const item of kaokaoItems || []) {
    if (!item || !item.id || !item.recog || !Array.isArray(item.recog.options)) continue;
    if (item.retired === true) continue;
    if (item.chunk && chunk && chunk.id && item.chunk !== chunk.id) continue;
    const pageId = locate.get(anchorBlockId(item.anchor)) || "";
    if (!pageId) continue;
    questions.push({ id: item.id, kind: "kaokao", pageId });
  }
  const byId = asMap(questionsById);
  for (const id of (chunk && chunk.questions) || []) {
    const question = byId.get(id);
    if (!question || !question.id || !String(question.answer || "").trim()) continue;
    if (question.verify?.status === "doubt" && String(question.verify.note || "").includes("缺题干背景")) continue;
    const anchor = (question.verify && question.verify.anchor) || question.anchor || "";
    const pageId = locate.get(anchorBlockId(anchor)) || null;
    questions.push({ id: question.id, kind: "exam", pageId });
  }
  return questions;
}

function answeredSet(answered) {
  if (answered instanceof Set) return answered;
  return new Set(answered || []);
}

function pickKaokao(readIds, byPage, done, used) {
  for (let i = readIds.length - 1; i >= 0; i -= 1) {
    for (const id of byPage.get(readIds[i]) || []) {
      if (done.has(id) || used.has(id)) continue;
      return id;
    }
  }
  return "";
}

/** Original pages in order. After every 3 pages, at most one unanswered 可考句 from the newest page that still has one. Unanswered exam questions are included. */
export function buildDefaultQueue(pages, questions, answered) {
  const done = answeredSet(answered);
  const pageIds = new Set((pages || []).map((page) => page.id));
  const kaokao = new Map();
  const exams = new Map();
  const tail = [];
  for (const question of questions || []) {
    if (!question || !question.id) continue;
    if (question.kind === "exam") {
      if (question.pageId && pageIds.has(question.pageId)) {
        const list = exams.get(question.pageId) || [];
        list.push(question.id);
        exams.set(question.pageId, list);
      } else tail.push(question.id);
      continue;
    }
    if (question.kind === "kaokao" && question.pageId && pageIds.has(question.pageId)) {
      const list = kaokao.get(question.pageId) || [];
      list.push(question.id);
      kaokao.set(question.pageId, list);
    }
  }
  const queue = [];
  const used = new Set();
  const readIds = [];
  (pages || []).forEach((page, index) => {
    queue.push(page.id);
    readIds.push(page.id);
    for (const id of exams.get(page.id) || []) {
      if (used.has(id) || done.has(id)) continue;
      used.add(id);
      queue.push(id);
    }
    if ((index + 1) % 3 === 0) {
      const id = pickKaokao(readIds, kaokao, done, used);
      if (id) {
        used.add(id);
        queue.push(id);
      }
    }
  });
  for (const id of tail) if (!used.has(id) && !done.has(id)) queue.push(id);
  return queue;
}

/** Completed browsing includes all original pages and every question already answered, without touching state. */
export function buildBrowseQueue(pages, questions, answered) {
  const done = answeredSet(answered);
  const prior = pages.flatMap(page => [page.id, ...questions.filter(q => q.pageId === page.id && done.has(q.id)).map(q => q.id)]);
  prior.push(...questions.filter(q => !q.pageId && done.has(q.id)).map(q => q.id));
  const queue = buildDefaultQueue(pages, questions, []);
  restoreQuestions(queue, prior, new Set(pages.map(p => p.id)), new Set(questions.map(q => q.id)), new Set());
  return applyPlan(queue, pages, questions, [], prior, answered).queue;
}

/** Page id plus every block on that page: used to remap reading history when pagination changes. */
export function flowPagesKey(pages) {
  return (pages || []).map((page) => {
    const id = String(page && page.id || "");
    const blocks = Array.isArray(page && page.blockIds) ? page.blockIds.map((blockId) => String(blockId)) : [];
    return `${id}:${blocks.join(",")}`;
  }).join("\n");
}

/** Repartition by block identity, preserving reading already done on this or another device. */
export function reconcileFlowRecord(record, pages, questions, answered) {
  const key = flowPagesKey(pages);
  const prev = record && typeof record === "object" ? record : {};
  const stored = typeof prev.pagesKey === "string" ? prev.pagesKey : "";
  if (stored !== key) {
    const oldSeen = new Set(prev.seen || []);
    const readBlocks = new Set();
    for (const line of stored.split("\n")) {
      const [id, ids = ""] = line.split(":");
      if (oldSeen.has(id)) for (const block of ids.split(",")) if (block) readBlocks.add(block);
    }
    // Pre-pagesKey records still name the first block of every visited page.
    if (!stored) for (const id of oldSeen) if (/^p\d+$/.test(id)) readBlocks.add(id.slice(1));
    const seen = pages.filter(page => (page.blockIds || []).some(id => readBlocks.has(String(id)))
      || (!stored && oldSeen.has(page.id))).map(page => page.id);
    let queue = buildDefaultQueue(pages, questions, answered);
    const origins = { ...prev.questionOrigins };
    for (const id of queue) if (questions.some(q => q.id === id)) origins[id] = { addedBy: "default" };
    // Keep historical answers and pending additions while remapping their page anchors.
    const qset = new Set(questions.map(q => q.id));
    for (const id of prev.queue || []) {
      if (!qset.has(id) || queue.includes(id)) continue;
      const q = questions.find(q => q.id === id);
      const at = q.pageId ? queue.lastIndexOf(q.pageId) + 1 : queue.length;
      queue.splice(at, 0, id);
    }
    const limited = limitAgentQuestions(queue, pages, questions, answered, origins);
    queue = limited.queue;
    const have = new Set(seen);
    const future = queue.filter(id => !have.has(id));
    // Continue at the first unread original page, keeping any still-unanswered questions next to it.
    const firstUnread = future.findIndex(id => pages.some(page => page.id === id));
    if (firstUnread > 0) future.unshift(...future.splice(firstUnread, 1));
    queue = seen.concat(future);
    return { queue, cursor: seen.length, seen, rule: "", pagesKey: key, rebuilt: true, fixes: limited.fixes, origins: limited.origins };
  }
  return {
    queue: Array.isArray(prev.queue) ? prev.queue.slice() : [],
    cursor: Math.max(0, Number(prev.cursor) || 0),
    seen: Array.isArray(prev.seen) ? prev.seen.slice() : [],
    rule: typeof prev.rule === "string" ? prev.rule : "",
    pagesKey: key,
    rebuilt: false
  };
}

export function dropUnresolved(queue, cursor, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  const list = Array.isArray(queue) ? queue : [];
  const next = [];
  const origin = Math.max(0, Number(cursor) || 0);
  let nextCursor = origin;
  for (let i = 0; i < list.length; i += 1) {
    if (valid.has(list[i])) next.push(list[i]);
    else if (i < origin) nextCursor -= 1;
  }
  if (nextCursor < 0) nextCursor = 0;
  if (nextCursor > next.length) nextCursor = next.length;
  return { queue: next, cursor: nextCursor, dropped: next.length !== list.length || nextCursor !== Math.max(0, Number(cursor) || 0) };
}

export function missingPages(pages, seen) {
  const have = new Set(seen || []);
  return (pages || []).map((page) => page.id).filter((id) => id && !have.has(id));
}

export function flowFinished(pages, seen, queue, cursor) {
  const pageIds = (pages || []).map((page) => page.id).filter(Boolean);
  if (!pageIds.length) return false;
  const have = new Set(seen || []);
  if (!pageIds.every((id) => have.has(id))) return false;
  return (Number(cursor) || 0) >= (queue || []).length;
}

function planItems(plan) {
  if (Array.isArray(plan)) return plan;
  if (plan && Array.isArray(plan.items)) return plan.items;
  return null;
}

/**
 * Unknown ids reject the whole plan.
 * Unread pages stay in their original order. Missing ones are inserted back into that order.
 * Questions and reread pages stay where they were relative to the unread pages around them.
 * Unanswered default questions must remain; agent additions can be removed. A seen page may be reread at most twice.
 */
export function applyPlan(plan, pages, questions, seen, oldQueue = buildDefaultQueue(pages, questions, []), answered = [], origins = {}) {
  const items = planItems(plan);
  if (!items) return { ok: false, error: "队列格式不对", queue: null, fixes: [] };
  const pageList = pages || [];
  const pageIds = pageList.map((page) => page.id);
  const pageSet = new Set(pageIds);
  const questionSet = new Set((questions || []).map((question) => question && question.id).filter(Boolean));
  const unknown = items.filter((id) => !pageSet.has(id) && !questionSet.has(id));
  if (unknown.length) {
    return { ok: false, error: `未知 id：${unknown.join("、")}`, queue: null, fixes: [] };
  }
  const seenSet = new Set(seen || []);
  const unread = pageIds.filter((id) => !seenSet.has(id));
  const unreadIndex = new Map(unread.map((id, index) => [id, index]));
  const fixes = [];
  const placedUnread = new Set();
  const reread = new Map();
  const usedQuestion = new Set();
  const slots = Array.from({ length: unread.length + 1 }, () => []);
  let lastCanonical = -1;

  for (const id of items) {
    if (unreadIndex.has(id)) {
      if (placedUnread.has(id)) {
        fixes.push(`未读页 ${id} 重复，已去掉`);
        continue;
      }
      const canonical = unreadIndex.get(id);
      if (canonical < lastCanonical) fixes.push(`未读页 ${id} 被打乱，已按原顺序放回`);
      placedUnread.add(id);
      lastCanonical = Math.max(lastCanonical, canonical);
      continue;
    }
    const slot = lastCanonical < 0 ? 0 : lastCanonical + 1;
    if (pageSet.has(id)) {
      const count = (reread.get(id) || 0) + 1;
      if (count > 2) {
        fixes.push(`页 ${id} 重看超过 2 次，已去掉`);
        continue;
      }
      reread.set(id, count);
      slots[slot].push(id);
      continue;
    }
    if (usedQuestion.has(id)) {
      fixes.push(`题目 ${id} 重复，已去掉`);
      continue;
    }
    usedQuestion.add(id);
    slots[slot].push(id);
  }

  const missing = unread.filter((id) => !placedUnread.has(id));
  if (missing.length) fixes.push(`补上未读原文：${missing.join("、")}`);
  const queue = slots[0].slice();
  for (let i = 0; i < unread.length; i += 1) {
    queue.push(unread[i]);
    queue.push(...slots[i + 1]);
  }
  const defaults = buildDefaultQueue(pages, questions, []);
  for (const [id, origin] of Object.entries(origins)) if (origin.addedBy === "default" && questionSet.has(id) && !defaults.includes(id)) defaults.push(id);
  const protectedIds = new Set(defaults);
  const protectedOld = oldQueue.filter(id => pageSet.has(id) || protectedIds.has(id));
  restoreQuestions(queue, protectedOld, pageSet, questionSet, answeredSet(answered), fixes);
  restoreQuestions(queue, defaults, pageSet, questionSet, answeredSet(answered), fixes);
  const limited = limitAgentQuestions(queue, pages, questions, answered, origins);
  return { ok: true, queue: limited.queue, origins: limited.origins, fixes: fixes.concat(limited.fixes), error: "" };
}

/** Restore a missing question after its preceding original page (or at the head if it is already behind us). */
function restoreQuestions(queue, previous, pages, questions, answered, fixes = []) {
  let anchor = "";
  const restored = new Map();
  for (const id of previous) {
    if (pages.has(id)) { anchor = id; continue; }
    if (!questions.has(id) || answered.has(id)) continue;
    if (!queue.includes(id)) {
      const after = restored.get(anchor) || anchor;
      const at = after ? queue.lastIndexOf(after) + 1 : 0;
      queue.splice(at, 0, id);
      restored.set(anchor, id);
      fixes.push(`补上未答题：${id}`);
    }
  }
}

/** The displayed prefix is immutable. Plans cannot move pending questions behind that prefix. */
export function replaceUnseen(queue, cursor, nextQueue, pages = [], questions = [], answered = [], origins = {}) {
  const list = Array.isArray(queue) ? queue : [];
  const index = Math.max(0, Math.min(Number(cursor) || 0, list.length));
  if (index >= list.length) return list.slice();
  const head = list.slice(0, index + 1);
  const pageSet = new Set(pages.map(page => page.id));
  const questionSet = new Set(questions.map(question => question.id));
  const done = answeredSet(answered);
  const tail = (nextQueue || []).filter(id => id !== list[index] &&
    !(questionSet.has(id) && head.includes(id)) &&
    (!head.includes(id) || pageSet.has(id)));
  // applyPlan has already ordered all unread pages; keep each pending question even if the model moved it ahead.
  const defaults = buildDefaultQueue(pages, questions, []);
  defaults.push(...Object.keys(origins).filter(id => origins[id]?.addedBy === "default" && !defaults.includes(id)));
  restoreQuestions(tail, defaults.filter(id => !head.includes(id)), pageSet, questionSet, done);
  return limitAgentQuestions(head.concat(tail), pages, questions, answered, origins).queue;
}

/** Segments only group complete reading pages. The queue and block identity stay intact. */
export function segmentPages(pages) {
  pages = pages.filter(page => page.kind !== "lesson");
  if (pages.length <= 12) return [pages.slice()];
  const segments = [];
  const count = Math.round(pages.length / 8);
  const size = Math.floor(pages.length / count);
  const extra = pages.length % count;
  let start = 0;
  for (let index = 0; index < count; index++) {
    const end = start + size + (index < extra ? 1 : 0);
    segments.push(pages.slice(start, end));
    start = end;
  }
  return segments;
}

/** A landing is due after its last page and the queued questions before the next new page. */
export function flowSegment(pages, queue, cursor, seen, completed = []) {
  const segments = segmentPages(pages);
  const consumed = new Set(seen);
  const acknowledged = new Set(completed);
  const before = new Set(queue.slice(0, cursor));
  for (let index = 0; index < segments.length; index++) {
    const part = segments[index];
    const next = segments[index + 1]?.[0]?.id;
    const boundary = next ? queue.indexOf(next) : queue.length;
    const complete = part.every(page => consumed.has(page.id)) && cursor >= boundary;
    if (segments.length > 1 && complete && !acknowledged.has(part.at(-1).id)) {
      return { pages: part, index, landing: true, count: part.length, end: part.at(-1).id };
    }
    if (!complete || index === segments.length - 1) {
      const count = part.filter(page => before.has(page.id)).length;
      const current = part.some(page => page.id === queue[cursor]);
      return { pages: part, index, landing: false,
        count: Math.min(part.length, count + (current ? 1 : 0)), end: part.at(-1)?.id };
    }
  }
}

/** Provenance is separate from string queue ids, so existing navigation stays compatible.
 * Answered items are historical evidence and are never removed by the quota. */
export function limitAgentQuestions(queue, pages, questions, answered = [], origins = {}) {
  const defaults = new Set(buildDefaultQueue(pages, questions, []));
  for (const [id, origin] of Object.entries(origins)) if (origin?.addedBy === "default") defaults.add(id);
  const byId = new Map(questions.map(q => [q.id, q]));
  const pageIds = new Set(pages.map(p => p.id));
  const done = answeredSet(answered);
  const nextOrigins = { ...origins }, fixes = [], counts = new Map();
  const limit = Math.floor(pages.length / 2);
  let anchor = "", total = 0;
  const next = queue.filter(id => {
    if (pageIds.has(id)) { anchor = id; return true; }
    const q = byId.get(id);
    if (!q || q.kind === "lesson") return true;
    // Default membership wins even if an older model tagged this question as added.
    const addedBy = defaults.has(id) ? "default" : (origins[id]?.addedBy || "agent");
    nextOrigins[id] = { addedBy };
    if (addedBy !== "agent") return true;
    const page = anchor || q.pageId || "tail";
    const count = counts.get(page) || 0;
    if (!done.has(id) && (count >= 2 || total >= limit)) {
      fixes.push(`追加题 ${id} 超过${count >= 2 ? "每页 2 道" : "本块原文页数一半"}，已截掉`);
      return false;
    }
    total++; counts.set(page, count + 1);
    return true;
  });
  return { queue: next, origins: nextOrigins, fixes };
}

export function migrateQuestionQueue(record, pages, questions, answered = []) {
  const limited = limitAgentQuestions(record.queue || [], pages, questions, answered, record.questionOrigins);
  const kept = new Set(limited.queue);
  const cursor = (record.queue || []).slice(0, record.cursor).filter(id => kept.has(id)).length;
  return { ...limited, cursor, changed: limited.fixes.length > 0 ||
    JSON.stringify(limited.origins) !== JSON.stringify(record.questionOrigins || {}) };
}

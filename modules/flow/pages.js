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
  return pages;
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
    if (item.chunk && chunk && chunk.id && item.chunk !== chunk.id) continue;
    const pageId = locate.get(anchorBlockId(item.anchor)) || "";
    if (!pageId) continue;
    questions.push({ id: item.id, kind: "kaokao", pageId });
  }
  const byId = asMap(questionsById);
  for (const id of (chunk && chunk.questions) || []) {
    const question = byId.get(id);
    if (!question || !question.id || !String(question.answer || "").trim()) continue;
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
  return applyPlan(buildDefaultQueue(pages, questions, []), pages, questions, [], prior).queue;
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
    // Older agent plans may contain additional unanswered questions. Keep those too.
    queue = applyPlan(queue, pages, questions, [], prev.queue || [], answered).queue;
    const have = new Set(seen);
    const future = queue.filter(id => !have.has(id));
    // Continue at the first unread original page, keeping any still-unanswered questions next to it.
    const firstUnread = future.findIndex(id => pages.some(page => page.id === id));
    if (firstUnread > 0) future.unshift(...future.splice(firstUnread, 1));
    queue = seen.concat(future);
    return { queue, cursor: seen.length, seen, rule: "", pagesKey: key, rebuilt: true };
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
 * Unanswered questions from the previous queue must remain. A seen page may be reread at most twice.
 */
export function applyPlan(plan, pages, questions, seen, oldQueue = buildDefaultQueue(pages, questions, []), answered = []) {
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
  restoreQuestions(queue, oldQueue, pageSet, questionSet, answeredSet(answered), fixes);
  return { ok: true, queue, fixes, error: "" };
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
export function replaceUnseen(queue, cursor, nextQueue, pages = [], questions = [], answered = []) {
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
  restoreQuestions(tail, list.slice(index + 1), pageSet, questionSet, done);
  return head.concat(tail);
}

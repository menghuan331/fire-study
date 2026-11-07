import { RULE_REASONS } from "./agent.js";

const ruleSet = new Set(RULE_REASONS);
const MARK_SPACE = /\s/u;
const CLOZE_BLANK = /_{3,}/;
const CONTEXT_CHARS = 4;
const FAR_PUNCT = new Set(Array.from("，。！？、；：,.!?;:…—～~·“”‘’「」『』《》〈〉（）()[]【】{}\"'`"));

const ui = {
  chunkId: "",
  itemId: "",
  qaOpen: false,
  notesOpen: false,
  choice: "",
  peek: false,
  quiet: 0,
  shownAt: 0,
  pendingAsk: ""
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text) {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

function decodeMark(value) {
  return String(value ?? "")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function foldMark(value) {
  const source = String(value ?? "");
  let folded = "";
  const spans = [];
  let index = 0;
  for (const ch of Array.from(source)) {
    const start = index;
    index += ch.length;
    const piece = ch.normalize("NFKC");
    for (const out of Array.from(piece)) {
      if (MARK_SPACE.test(out)) continue;
      folded += out;
      spans.push({ start, end: index });
    }
  }
  return { folded, spans };
}

/** NFKC plus whitespace only. Decimal points, signs, and inequality marks stay, then the hit maps back onto the original text. */
export function locateFold(text, needle, from = 0, to) {
  const raw = String(text ?? "");
  const end = to == null ? raw.length : to;
  const startAt = Math.max(0, Number(from) || 0);
  if (startAt >= end) return null;
  const hay = foldMark(raw.slice(startAt, end));
  const pin = foldMark(decodeMark(needle));
  if (!pin.folded) return null;
  const at = hay.folded.indexOf(pin.folded);
  if (at < 0) return null;
  return {
    start: startAt + hay.spans[at].start,
    end: startAt + hay.spans[at + pin.folded.length - 1].end
  };
}

export function locateSource(text, src) {
  return locateFold(text, src);
}

export function answerForms(answer) {
  const text = String(answer ?? "").trim();
  if (!text) return [];
  const forms = [text];
  if (/[/、]/.test(text)) {
    for (const part of text.split(/[/、]/)) {
      const item = part.trim();
      if (item && !forms.includes(item)) forms.push(item);
    }
  }
  return forms;
}

function locateNext(text, needle, used) {
  const raw = String(text ?? "");
  let from = 0;
  while (from < raw.length) {
    const found = locateFold(raw, needle, from, raw.length);
    if (!found) return null;
    const taken = (used || []).some((span) => span.start === found.start && span.end === found.end);
    if (!taken) return found;
    const next = found.end > from ? found.end : from + 1;
    if (next <= from) return null;
    from = next;
  }
  return null;
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function dedupeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const range of sorted) {
    if (!range || range.end <= range.start) continue;
    if (kept.some((item) => rangesOverlap(item, range))) continue;
    kept.push(range);
  }
  return kept.sort((a, b) => a.start - b.start || a.end - b.end);
}

function clozeSentence(item) {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.cloze === "string") return item.cloze;
  if (item.cloze && typeof item.cloze.text === "string") return item.cloze.text;
  return "";
}

function edgeChars(fragment, side) {
  const chars = Array.from(foldMark(decodeMark(fragment)).folded);
  if (!chars.length) return "";
  const window = side === "before" ? chars.slice(-CONTEXT_CHARS) : chars.slice(0, CONTEXT_CHARS);
  if (side === "before") {
    while (window.length > 1 && FAR_PUNCT.has(window[0])) window.shift();
  } else {
    while (window.length > 1 && FAR_PUNCT.has(window[window.length - 1])) window.pop();
  }
  return window.join("");
}

function answerExtends(folded, at, length) {
  const pin = folded.slice(at, at + length);
  if (!/[0-9]/.test(pin)) return false;
  const before = at > 0 ? folded[at - 1] : "";
  const after = folded[at + length] || "";
  return /[0-9.]/.test(before) || /[0-9]/.test(after);
}

function locateBlank(raw, from, to, beforeFrag, afterFrag, answer) {
  const left = edgeChars(beforeFrag, "before");
  const right = edgeChars(afterFrag, "after");
  if (!left && !right) return null;
  const start = Math.max(0, from);
  const end = to == null ? String(raw ?? "").length : to;
  if (start >= end) return null;
  const hay = foldMark(String(raw ?? "").slice(start, end));
  if (!hay.folded) return null;
  for (const form of answerForms(answer)) {
    const pin = foldMark(decodeMark(form)).folded;
    if (!pin) continue;
    const pattern = left + pin + right;
    let at = 0;
    while (at < hay.folded.length) {
      const found = hay.folded.indexOf(pattern, at);
      if (found < 0) break;
      const markAt = found + left.length;
      if (!answerExtends(hay.folded, markAt, pin.length)) {
        const span = hay.spans[markAt];
        const tail = hay.spans[markAt + pin.length - 1];
        if (span && tail) return { start: start + span.start, end: start + tail.end };
      }
      const next = found + 1;
      if (next <= at) break;
      at = next;
    }
  }
  return null;
}

/** Each blank is marked inside its own src, using the cloze text around that blank. A blank whose context does not match is skipped. */
export function planKeywordMarks(text, items) {
  const raw = String(text ?? "");
  const used = [];
  const ranges = [];
  let hits = 0;
  let total = 0;
  let skipped = 0;
  for (const item of items || []) {
    if (!item || item.src == null) continue;
    const answers = Array.isArray(item.answers)
      ? item.answers
      : (item.answers == null || item.answers === "" ? [] : [item.answers]);
    if (!answers.length) continue;
    total += 1;
    const sentence = clozeSentence(item);
    const parts = CLOZE_BLANK.test(sentence) ? sentence.split(CLOZE_BLANK) : null;
    const blanks = parts ? parts.length - 1 : 0;
    const slots = Math.max(blanks, answers.length);
    const src = locateNext(raw, item.src, used);
    if (!src) {
      skipped += slots;
      continue;
    }
    used.push(src);
    if (!parts) {
      skipped += slots;
      continue;
    }
    let cursor = src.start;
    let marked = 0;
    for (let i = 0; i < slots; i += 1) {
      if (i >= blanks || answers[i] == null || answers[i] === "") {
        skipped += 1;
        continue;
      }
      const found = locateBlank(raw, cursor, src.end, parts[i], parts[i + 1], answers[i]);
      if (!found) {
        skipped += 1;
        continue;
      }
      ranges.push(found);
      marked += 1;
      cursor = found.end;
    }
    if (marked) hits += 1;
  }
  return { ranges: dedupeRanges(ranges), hits, total, skipped };
}

function ruleText(model) {
  const explicit = String(model && model.rule || "").trim();
  if (explicit) return explicit;
  const text = String(model && model.reason || "").trim();
  return ruleSet.has(text) ? text : "";
}

function collectText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let raw = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const marked = !!(node.parentElement && node.parentElement.closest(".flow-src"));
    nodes.push({ node, start: raw.length, marked });
    raw += node.textContent || "";
  }
  return { raw, nodes };
}

function markRange(nodes, start, end) {
  const slices = [];
  for (const entry of nodes) {
    const length = (entry.node.textContent || "").length;
    const nodeEnd = entry.start + length;
    const from = Math.max(start, entry.start);
    const to = Math.min(end, nodeEnd);
    if (from >= to) continue;
    if (entry.marked) return false;
    slices.push({ node: entry.node, from: from - entry.start, to: to - entry.start });
  }
  if (!slices.length) return false;
  for (let i = slices.length - 1; i >= 0; i -= 1) {
    const slice = slices[i];
    const range = document.createRange();
    range.setStart(slice.node, slice.from);
    range.setEnd(slice.node, slice.to);
    const mark = document.createElement("strong");
    mark.className = "flow-src";
    try { range.surroundContents(mark); }
    catch {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    }
  }
  return true;
}

function markKeywords(root, items) {
  if (!root) return;
  const seed = collectText(root);
  const ranges = planKeywordMarks(seed.raw, items).ranges.slice().sort((a, b) => b.start - a.start || b.end - a.end);
  for (const range of ranges) {
    const { nodes } = collectText(root);
    markRange(nodes, range.start, range.end);
  }
}

function optionButton(option, question) {
  const node = button("flow-option");
  node.dataset.choice = option.key;
  const key = el("span", "flow-letter", `${option.label}.`);
  const text = el("span", "flow-option-text", option.text);
  node.append(key, text);
  if (!question.result) return node;
  const correct = new Set(question.result.correctKeys || []);
  const chosen = new Set(question.result.choiceKeys || []);
  if (correct.has(option.key)) { node.classList.add("is-ok"); node.append(el("span", "flow-verdict", "✓")); }
  else if (chosen.has(option.key)) { node.classList.add("is-bad"); node.append(el("span", "flow-verdict", "✕")); }
  else node.classList.add("is-dim");
  node.disabled = true;
  return node;
}

function drawQuestion(host, question) {
  const wrap = el("div", "flow-question");
  wrap.append(el("p", "flow-stem", question.stem || "（题干缺失）"));
  const list = el("div", "flow-options");
  for (const option of question.options || []) {
    const node = optionButton(option, question);
    if (!question.result && host.browsing) node.disabled = true;
    else if (!question.result && !question.multi) {
      node.addEventListener("click", () => host.onAnswer(option.key));
    } else if (!question.result && question.multi) {
      const on = ui.choice.includes(option.key);
      node.classList.toggle("is-on", on);
      node.setAttribute("aria-pressed", on ? "true" : "false");
      node.addEventListener("click", () => {
        const set = new Set(ui.choice.split("").filter(Boolean));
        if (set.has(option.key)) set.delete(option.key);
        else set.add(option.key);
        ui.choice = [...set].sort().join("");
        host.refresh();
      });
    }
    list.append(node);
  }
  wrap.append(list);
  if (question.multi && !question.result && !host.browsing) {
    const submit = button("flow-next flow-submit", "提交");
    submit.id = "flow-submit";
    submit.disabled = !ui.choice;
    submit.addEventListener("click", () => host.onAnswer(ui.choice));
    wrap.append(submit);
  }
  if (question.result) {
    const line = el("p", `flow-result${question.result.ok ? " is-ok" : " is-bad"}`, question.result.ok ? "对了" : "错了");
    wrap.append(line);
    if (question.result.why) wrap.append(el("p", "flow-why", question.result.why));
    if (question.source && question.source.text) {
      const link = button("flow-source", question.source.text);
      link.id = "flow-source";
      link.addEventListener("click", () => {
        ui.peek = true;
        host.refresh();
      });
      wrap.append(link);
    }
  }
  return wrap;
}

function drawBar(host, model) {
  const bar = el("div", "flow-bar");
  const previous = button("flow-ask", "上一页");
  previous.id = "flow-previous";
  previous.disabled = !model.canPrevious;
  previous.addEventListener("click", () => { ui.qaOpen = false; ui.peek = false; host.onPrevious(); });
  bar.append(previous);
  const next = button("flow-next", model.mode === "done" ? "下一块" : "下一页");
  next.id = model.mode === "done" ? "flow-next-chunk" : "flow-next";
  if (model.mode === "done" && !model.nextId) next.disabled = true;
  if (model.mode === "question" && !model.question?.result && !model.browsing) next.disabled = true;
  next.addEventListener("click", () => {
    if (model.mode === "done") {
      if (model.nextId) host.onOpen(model.nextId);
      return;
    }
    const sec = Math.max(0, Math.round((Date.now() - ui.shownAt) / 1000));
    ui.qaOpen = false;
    ui.peek = false;
    host.onNext({ sec });
  });
  const ask = button("flow-ask", "问一下");
  ask.id = "flow-ask";
  ask.setAttribute("aria-expanded", ui.qaOpen ? "true" : "false");
  ask.addEventListener("click", () => {
    ui.qaOpen = !ui.qaOpen;
    ui.pendingAsk = "";
    host.refresh();
  });
  bar.append(next, ask);
  if (model.mode === "done") { ask.disabled = true; return bar; }
  if (model.figure && model.mode === "read") {
    const figure = button("flow-ask", "这张图在讲什么");
    figure.id = "flow-ask-figure";
    figure.addEventListener("click", () => {
      ui.qaOpen = true;
      ui.pendingAsk = "这张图在讲什么";
      host.refresh();
    });
    bar.append(figure);
  }
  return bar;
}

function drawNotes(host, model) {
  const panel = el("section", "flow-notes");
  panel.id = "flow-notes";
  if (model.moreReview) {
    const more = button("flow-ask", "再来 10 张");
    more.id = "review-more";
    more.addEventListener("click", () => host.onMoreReview());
    panel.append(more);
  }
  const rule = ruleText(model);
  if (rule) {
    const line = el("p", "flow-rule", rule);
    line.id = "flow-rule";
    panel.append(line);
  }
  const decisions = (model.decisions || []).filter((decision) => decision && decision.text && decision.text !== rule);
  if (decisions.length) {
    const group = el("div", "flow-decisions");
    panel.append(group);
    for (const decision of decisions) {
      group.append(el("p", "flow-note", decision.text || ""));
    }
  }
  for (const error of model.errors || []) panel.append(el("p", "flow-rule",
    `状态 ${error.status || "—"} · ${error.code || "ERROR"}${error.finish_reason ? ` · ${error.finish_reason}` : ""}`));
  const notes = model.notes || [];
  if (!notes.length) panel.append(el("p", "flow-note", "还没有笔记"));
  for (const note of notes) {
    const row = el("div", "flow-note-row");
    row.append(el("p", "flow-note", note.text || ""));
    const remove = button("flow-ask", "删除");
    remove.addEventListener("click", () => host.onDeleteNote(note.id));
    row.append(remove);
    panel.append(row);
  }
  return panel;
}

export function renderFlow(root, model) {
  if (!root || !model) return;
  if (ui.chunkId !== model.chunkId) {
    ui.chunkId = model.chunkId || "";
    ui.itemId = "";
    ui.qaOpen = false;
    ui.notesOpen = false;
    ui.choice = "";
    ui.peek = false;
    ui.quiet = 0;
    ui.shownAt = Date.now();
    ui.pendingAsk = "";
  }
  const changed = model.itemId !== ui.itemId;
  if (changed) {
    ui.itemId = model.itemId || "";
    ui.qaOpen = false;
    ui.choice = "";
    ui.peek = false;
    ui.pendingAsk = "";
    ui.shownAt = Date.now();
  }
  root.replaceChildren();
  root.classList.add("flow");
  root.dataset.chunk = model.chunkId || "";
  root.dataset.item = model.itemId || "";
  root.dataset.mode = model.mode || model.status || "";
  root.dataset.cursor = String(model.cursor || 0);
  root.dataset.total = String(model.total || 0);

  const head = el("header", "flow-top");
  const count = el("p", "flow-count", model.total ? `${model.cursor} / ${model.total}` : "");
  count.id = "flow-count";
  const exit = button("flow-ask", "菜单");
  exit.id = "flow-menu-open";
  exit.addEventListener("click", () => model.onMenu());
  head.append(count, exit);
  const progress = el("div", "flow-progress");
  const fill = el("span");
  const ratio = model.total ? Math.min(1, (model.progressCursor ?? model.cursor ?? 0) / model.total) : 0;
  fill.style.width = `${Math.round(ratio * 100)}%`;
  progress.append(fill);
  progress.setAttribute("aria-hidden", "true");
  root.append(head, progress);

  const why = button("flow-ask", "笔记");
  why.id = "flow-why";
  why.addEventListener("click", () => {
    ui.notesOpen = !ui.notesOpen;
    model.refresh();
  });
  const tools = el("div", "flow-top-tools");
  tools.append(why, exit);
  head.append(tools);
  if (ui.notesOpen) root.append(drawNotes(model, model));

  const article = el("article", "flow-copy");
  article.id = "flow-copy";
  if (changed) article.classList.add(model.animation === "back" ? "flow-slide-back" : "flow-slide-forward");
  if (model.status === "loading") {
    article.append(el("p", "flow-stem", "正在读取原文…"));
  } else if (model.status === "missing") {
    article.append(el("p", "flow-stem", model.message || "这一块的原文暂时没读到。"));
  } else if (model.mode === "done") {
    article.append(el("h1", "flow-title", "这块学完了"));
    article.append(el("p", "flow-stem", `答对 ${model.correct || 0} 道`));
    article.id = "flow-done";
  } else if (ui.peek && model.peekHtml) {
    const back = button("flow-source", "回到这题");
    back.id = "flow-back-question";
    back.addEventListener("click", () => {
      ui.peek = false;
      model.refresh();
    });
    article.append(back);
    const source = el("div", "flow-blocks");
    source.innerHTML = model.peekHtml;
    article.append(source);
  } else if (model.mode === "question" && model.question) {
    article.append(drawQuestion(model, model.question));
  } else {
    const blocks = el("div", "flow-blocks");
    blocks.innerHTML = model.html || "";
    markKeywords(blocks, model.sources);
    article.append(blocks);
  }
  root.append(article);

  if (ui.qaOpen && model.mode !== "done") {
    const slot = el("div", "flow-qa");
    slot.id = "flow-qa";
    root.append(slot);
  }
  if (model.status === "ready" || model.mode === "done") root.append(drawBar(model, model));
  if (ui.qaOpen && model.mountQa) {
    const slot = root.querySelector("#flow-qa");
    const handle = slot ? model.mountQa(slot) : null;
    if (handle && ui.pendingAsk && typeof handle.ask === "function") {
      const text = ui.pendingAsk;
      ui.pendingAsk = "";
      handle.ask(text);
    }
  }
}

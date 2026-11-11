import { RULE_REASONS } from "./agent.js";
import { applyRhythmReading, mountSourceDisclosure } from "./reading.js";
export { rhythmEnabled, RHYTHM_STORAGE_KEY, mountSourceDisclosure } from "./reading.js";

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
  source: {},
  quiet: 0,
  shownAt: 0,
  focus: "",
  lessonRetell: {},
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

export function answerProvenanceText(provenance) {
  return ({ textbook: "来源没给答案，按教材作答", corrected: "来源答案有误，已按教材改正", written: "仿真题，按教材出" })[provenance?.answer] || "";
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
    const provenance = question.kind === "exam" ? answerProvenanceText(question.provenance) : "";
    if (provenance) wrap.append(el("p", "flow-provenance", provenance));
    if (question.source && question.source.text) {
      const link = button("flow-source", question.source.text);
      link.id = "flow-source";
      wrap.append(link);
    }
  }
  return wrap;
}

// The run log is for checking afterwards; give tool names a plain Chinese label.
const RUN_LABELS = { queue_migration: "题量整理", consolidate_profile: "档案整理", insert_lesson: "插入补课",
  lesson_discard: "补课没通过自检", retire_question: "停用考点题", rewrite_explanation: "改写解释",
  flag_question: "记存疑", disable_lesson: "停用补课", lesson_retell: "复述反馈", review_insert: "错题进复习",
  read_learner: "看学习记录", list_pages: "看页目录", read_page: "读原文", set_queue: "排题", write_note: "写笔记" };

// The host supplies sanitized formatters; without them text stays plain.
function richEl(tag, className, text, format) {
  const node = el(tag, className);
  if (typeof format === "function") node.innerHTML = format(String(text ?? ""));
  else node.textContent = String(text ?? "");
  return node;
}

function drawLesson(host, model) {
  const lesson = model.lesson;
  const format = model.format || {};
  const wrap = el("div", "flow-lesson");
  wrap.append(richEl("div", "flow-lesson-line", lesson.oneLine, format.model), richEl("div", "flow-lesson-example", lesson.example, format.model));
  const source = el("div", "flow-blocks flow-lesson-source");
  source.append(richEl("div", "", lesson.link.text, format.model));
  source.append(richEl("blockquote", "flow-lesson-quote", lesson.link.quote, format.textbook));
  source.append(el("p", "flow-lesson-citation", model.lessonCitation || lesson.link.anchor));
  wrap.append(source, drawQuestion(host, model.question));
  if (model.question.result && !model.browsing) {
    const state = ui.lessonRetell[model.itemId] ||= { text: "", checked: "", feedback: "" };
    const input = el("textarea", "flow-lesson-retell");
    input.placeholder = "用自己的话说一遍";
    input.setAttribute("aria-label", "用自己的话说一遍（选填）");
    input.maxLength = 1000; input.rows = 2; input.value = state.text;
    const feedback = el("p", "flow-why", state.feedback);
    feedback.setAttribute("aria-live", "polite");
    input.addEventListener("input", () => { state.text = input.value; });
    model.reviewRetell = async () => {
      const text = state.text.trim();
      if (!text || state.checked === text || !model.onRetell) return true;
      if (state.pending) return false;
      state.pending = true; input.disabled = true;
      try { state.feedback = await model.onRetell(text); state.checked = text; feedback.textContent = state.feedback; }
      finally { state.pending = false; input.disabled = false; }
      return false;
    };
    wrap.append(input, feedback);
  }
  const reject = button("flow-ask flow-lesson-reject", "讲得不对");
  reject.addEventListener("click", () => model.onRejectLesson());
  wrap.append(reject);
  return wrap;
}

function drawBar(host, model) {
  const bar = el("div", "flow-bar");
  if (model.mode === "segment") {
    const next = button("flow-next", "继续");
    next.id = "flow-next";
    next.addEventListener("click", () => host.onNext({ sec: 0 }));
    bar.append(next);
    return bar;
  }
  const previous = button("flow-ask", "上一页");
  previous.id = "flow-previous";
  previous.disabled = !model.canPrevious;
  previous.addEventListener("click", () => { ui.qaOpen = false; ui.source = {}; host.onPrevious(); });
  bar.append(previous);
  const next = button("flow-next", model.mode === "done" ? "下一块" : "下一页");
  next.id = model.mode === "done" ? "flow-next-chunk" : "flow-next";
  if (model.mode === "done" && !model.nextId) next.disabled = true;
  if (["question", "lesson"].includes(model.mode) && !model.question?.result && !model.browsing) next.disabled = true;
  next.addEventListener("click", async () => {
    if (model.mode === "done") {
      if (model.nextId) host.onOpen(model.nextId);
      return;
    }
    if (model.mode === "lesson" && model.reviewRetell && !await model.reviewRetell()) return;
    const sec = Math.max(0, Math.round((Date.now() - ui.shownAt) / 1000));
    ui.qaOpen = false;
    ui.source = {};
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
  bar.append(next);
  if (model.mode !== "lesson") bar.append(ask);
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
  for (const run of model.runs || []) {
    const row = el("details", "flow-run");
    row.append(el("summary", "flow-rule", RUN_LABELS[run.name] || run.name || "agent"), el("pre", "flow-run-detail", JSON.stringify({ arguments: run.arguments, result: run.result }, null, 2)));
    panel.append(row);
  }
  const notes = model.notes || [];
  if (!notes.length) panel.append(el("p", "flow-note", "还没有档案"));
  for (const note of notes) {
    const row = el("div", "flow-note-row");
    const detail = el("div", "flow-note-detail");
    detail.append(el("p", "flow-note", note.text || ""));
    if (note.evidence?.length) detail.append(el("p", "flow-rule", note.evidence.map(e => `${new Date(e.at).toLocaleDateString("zh-CN")} · ${e.id}`).join("；")));
    row.append(detail);
    const remove = button("flow-ask", "删除");
    remove.addEventListener("click", () => host.onDeleteNote(note.id));
    row.append(remove);
    panel.append(row);
  }
  return panel;
}

// Wrap text-node slices, preserving inline emphasis and textbook markup.
export function selectSentences(container, selected, onSelect) {
  const doc = container.ownerDocument;
  for (const paragraph of container.querySelectorAll("p, li")) {
    if (paragraph.querySelector("p, li") || paragraph.closest("table, .katex")) continue;
    const walker = doc.createTreeWalker(paragraph, 4);
    const nodes = [];
    let text = "", node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest(".katex, script, style")) continue;
      nodes.push({ node, start: text.length }); text += node.textContent;
    }
    const sentences = [...text.matchAll(/[^。！？!?]*[。！？!?]+|[^。！？!?]+$/gu)];
    for (const { node, start } of nodes) {
      const fragment = doc.createDocumentFragment();
      for (const sentence of sentences) {
        const from = Math.max(0, sentence.index - start);
        const to = Math.min(node.length, sentence.index + sentence[0].length - start);
        if (to <= from) continue;
        const span = el("span", "flow-sentence", node.textContent.slice(from, to));
        const value = sentence[0].trim();
        span.classList.toggle("is-selected", !!value && value === selected);
        span.addEventListener("click", event => {
          if (event.target.closest("a, button")) return;
          for (const other of container.querySelectorAll(".flow-sentence")) other.classList.remove("is-selected");
          for (const part of paragraph.querySelectorAll(".flow-sentence")) {
            if (part.dataset.sentence === value) part.classList.add("is-selected");
          }
          onSelect(value);
        });
        span.dataset.sentence = value;
        fragment.append(span);
      }
      node.replaceWith(fragment);
    }
  }
}

// The QA column stays attached while it is open on one item, so its scroll, draft and caret survive re-renders.
const qaRegion = { key: "", slot: null, onClose: null };

function createQaRegion() {
  const slot = el("aside", "flow-qa");
  slot.id = "flow-qa";
  slot.setAttribute("aria-label", "答疑");
  const close = button("flow-qa-close", "×");
  close.setAttribute("aria-label", "收起答疑");
  close.addEventListener("click", () => qaRegion.onClose?.());
  slot.append(close);
  return slot;
}

/** Shared by the learning flow and review: swaps everything except an open QA column. Returns the QA slot or null. */
export function paintFlow(root, { top = [], article, bar, qa = null }) {
  const kept = qa && qaRegion.key === qa.key && qaRegion.slot?.parentElement?.parentElement === root ? qaRegion.slot : null;
  let slot = kept;
  if (kept) {
    const workspace = kept.parentElement;
    for (const child of [...root.children]) if (child !== workspace) child.remove();
    for (const child of [...workspace.children]) if (child !== kept) child.remove();
    root.prepend(...top);
    workspace.prepend(article);
    if (bar) root.append(bar);
  } else {
    const workspace = el("div", "flow-workspace");
    slot = qa ? createQaRegion() : null;
    workspace.append(article, ...(slot ? [slot] : []));
    root.replaceChildren(...top, workspace, ...(bar ? [bar] : []));
  }
  Object.assign(qaRegion, qa ? { key: qa.key, slot, onClose: qa.onClose } : { key: "", slot: null, onClose: null });
  root.classList.toggle("has-qa", !!slot);
  return slot;
}

/** iPad keyboard: the page follows the visual viewport, so content, transcript and composer all stay visible. */
export function trackViewport(win = globalThis) {
  const viewport = win.visualViewport;
  if (!viewport) return;
  const style = win.document.documentElement.style;
  const apply = () => {
    style.setProperty("--flow-vh", `${viewport.height}px`);
    style.setProperty("--flow-vtop", `${viewport.offsetTop}px`);
  };
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  apply();
}

export function readingContent(source) {
  const blocks = el("div", "flow-blocks");
  blocks.innerHTML = source.html || "";
  markKeywords(blocks, source.sources);
  return blocks;
}

export function renderFlow(root, model) {
  if (!root || !model) return;
  if (ui.chunkId !== model.chunkId) {
    ui.chunkId = model.chunkId || "";
    ui.itemId = "";
    ui.qaOpen = false;
    ui.notesOpen = false;
    ui.choice = "";
    ui.source = {};
    ui.quiet = 0;
    ui.shownAt = Date.now();
    ui.pendingAsk = "";
  }
  const changed = model.itemId !== ui.itemId;
  if (changed) {
    ui.itemId = model.itemId || "";
    ui.qaOpen = false;
    ui.choice = "";
    ui.source = {};
    ui.pendingAsk = "";
    ui.focus = "";
    ui.shownAt = Date.now();
  }
  const oldArticle = root.querySelector("#flow-copy");
  const scrollTop = changed ? 0 : (oldArticle?.scrollTop || 0);
  root.classList.add("flow");
  root.dataset.chunk = model.chunkId || "";
  root.dataset.item = model.itemId || "";
  root.dataset.mode = model.mode || model.status || "";
  root.dataset.cursor = String(model.cursor || 0);
  root.dataset.total = String(model.total || 0);

  const head = el("header", "flow-top");
  const displayTotal = model.displayTotal ?? model.total;
  const displayCursor = model.displayCursor ?? model.cursor;
  const count = el("p", "flow-count", displayTotal ? `${displayCursor} / ${displayTotal}` : "");
  count.id = "flow-count";
  const exit = button("flow-ask", "菜单");
  exit.id = "flow-menu-open";
  exit.addEventListener("click", () => model.onMenu());
  head.append(count);
  if (model.mode === "lesson") head.append(el("span", "flow-lesson-label", "补课"));
  if (model.printed && ["read", "question"].includes(model.mode)) {
    const location = el("p", "flow-printed");
    location.append(el("span", "flow-book", `${model.printed.name} · `), el("span", "", model.printed.pages));
    location.title = `${model.printed.name} · ${model.printed.pages}`;
    head.append(location);
  }
  head.append(exit);
  const progress = el("div", "flow-progress");
  const fill = el("span");
  const ratio = displayTotal ? Math.min(1, (model.displayProgressCursor ?? model.progressCursor ?? model.cursor ?? 0) / displayTotal) : 0;
  fill.style.width = `${Math.round(ratio * 100)}%`;
  progress.append(fill);
  progress.setAttribute("aria-hidden", "true");

  const why = button("flow-ask", "笔记");
  why.id = "flow-why";
  why.hidden = model.mode === "segment";
  why.addEventListener("click", () => {
    ui.notesOpen = !ui.notesOpen;
    model.refresh();
  });
  const tools = el("div", "flow-top-tools");
  tools.append(why, exit);
  head.append(tools);

  const article = el("article", "flow-copy");
  article.id = "flow-copy";
  if (changed) article.classList.add(model.animation === "back" ? "flow-slide-back" : "flow-slide-forward");
  if (model.status === "loading") {
    article.append(el("p", "flow-stem", "正在读取原文…"));
  } else if (model.status === "missing") {
    article.append(el("p", "flow-stem", model.message || "这一块的原文暂时没读到。"));
  } else if (model.mode === "segment") {
    article.append(el("h1", "flow-title", "这一段完了"));
    article.append(el("p", "flow-stem", `${model.segmentPages} 页 · 答对 ${model.segmentCorrect} 道 · 答错 ${model.segmentWrong} 道`));
  } else if (model.mode === "done") {
    article.append(el("h1", "flow-title", "这块学完了"));
    article.append(el("p", "flow-stem", `答对 ${model.correct || 0} 道`));
    article.id = "flow-done";
  } else if (model.mode === "lesson" && model.lesson) {
    article.append(drawLesson(model, model));
  } else if (model.mode === "question" && model.question) {
    article.append(drawQuestion(model, model.question));
    if (model.question.kind === "exam" && model.question.result) {
      const flag = button("flow-ask flow-lesson-reject", model.question.flagged ? "已记下" : "这题有问题");
      flag.id = "flow-flag-question"; flag.disabled = !!model.question.flagged;
      flag.addEventListener("click", () => {
        model.onFlagQuestion(); flag.textContent = "已记下"; flag.disabled = true;
      });
      article.append(flag);
    }
  } else {
    const blocks = readingContent(model);
    applyRhythmReading(blocks, `${model.chunkId}:${model.itemId}`, model.rhythm);
    selectSentences(blocks, ui.focus, value => { ui.focus = value; if (ui.qaOpen) model.refresh(); });
    article.append(blocks);
  }
  if (ui.notesOpen && model.mode !== "segment") article.prepend(drawNotes(model, model));
  const qaShown = ui.qaOpen && model.mode !== "done";
  const slot = paintFlow(root, {
    top: [head, progress], article,
    bar: model.status === "ready" || model.mode === "done" ? drawBar(model, model) : null,
    qa: qaShown ? { key: `flow:${model.chunkId}:${model.itemId}`, onClose: () => { ui.qaOpen = false; model.refresh(); } } : null
  });
  article.scrollTop = scrollTop;
  if (model.mode === "question" && model.question?.result) {
    mountSourceDisclosure(article, article.querySelector("#flow-source"), model.source || {}, ui.source, model.refresh, readingContent, scrollTop);
  }
  if (slot && model.mountQa) {
    const handle = model.mountQa(slot, ui.focus);
    if (handle && ui.pendingAsk && typeof handle.ask === "function") {
      const text = ui.pendingAsk;
      ui.pendingAsk = "";
      handle.ask(text);
    }
  }
}

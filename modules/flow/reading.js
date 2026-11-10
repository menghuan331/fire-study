// Local presentation only: never included in the synced study state.
export const RHYTHM_STORAGE_KEY = "study-rhythm-reading-v1";

export function rhythmEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(RHYTHM_STORAGE_KEY) === "1"; } catch { return false; }
}

function randomFor(seed) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.codePointAt(0), 16777619);
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

/** Stable sampling within each sentence; offsets refer to the unchanged source text. */
export function rhythmRanges(text, seed, Segmenter = globalThis.Intl?.Segmenter) {
  const random = randomFor(seed);
  const segmenter = Segmenter ? new Segmenter("zh", { granularity: "word" }) : null;
  const ranges = [];
  for (const sentence of text.matchAll(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu)) {
    const words = segmenter
      ? [...segmenter.segment(sentence[0])].filter(word => word.isWordLike && /^[\p{Script=Han}]{2,}$/u.test(word.segment)).map(word => ({ start: word.index, end: word.index + word.segment.length }))
      : [...sentence[0].matchAll(/[\p{Script=Han}]{2}/gu)].map(word => ({ start: word.index, end: word.index + word[0].length }));
    const count = Math.round(words.length / 5);
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [words[i], words[j]] = [words[j], words[i]];
    }
    for (const word of words.slice(0, count)) ranges.push({ start: sentence.index + word.start, end: sentence.index + word.end });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function applyRhythmReading(root, seed, enabled) {
  if (!enabled) return;
  root.classList.add("flow-rhythm");
  root.querySelectorAll("p, li, td, th").forEach((paragraph, index) => {
    if (paragraph.querySelector("p, li, td, th") || paragraph.closest(".read-equation, .katex")) return;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      nodes.push({ node, start: text.length, protected: !!node.parentElement.closest("strong, b, .flow-src, .katex, code, .rhythm-emphasis") });
      text += node.textContent;
    }
    for (const word of rhythmRanges(text, `${seed}:${index}`).reverse()) {
      const slices = nodes.filter(entry => entry.start < word.end && entry.start + entry.node.textContent.length > word.start);
      if (slices.some(entry => entry.protected)) continue;
      for (const entry of slices.reverse()) {
        const range = document.createRange();
        range.setStart(entry.node, Math.max(0, word.start - entry.start));
        range.setEnd(entry.node, Math.min(entry.node.textContent.length, word.end - entry.start));
        const span = document.createElement("span");
        span.className = "rhythm-emphasis";
        range.surroundContents(span);
      }
    }
  });
}

/** Same disclosure interaction for study questions, exam review and cloze review. */
export function mountSourceDisclosure(article, trigger, source, state, refresh, renderContent, scrollTop = article.scrollTop) {
  if (!trigger) return;
  const toggle = () => {
    if (!state.open) state.returnTop = article.scrollTop;
    state.open = !state.open;
    state.scroll = state.open ? "source" : "return";
    refresh();
  };
  trigger.setAttribute("aria-expanded", String(!!state.open));
  trigger.setAttribute("aria-controls", "flow-source-panel");
  trigger.addEventListener("click", toggle);
  let panel;
  if (state.open) {
    panel = document.createElement("section");
    panel.className = "flow-source-panel";
    panel.id = "flow-source-panel";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "flow-source-close";
    close.setAttribute("aria-label", "收起原文");
    close.textContent = "×";
    close.addEventListener("click", toggle);
    panel.append(close, renderContent(source));
    article.append(panel);
    const anchor = String(source.anchor || "").match(/b(\d+)\s*$/)?.[1];
    for (const block of panel.querySelectorAll("[data-block-id]")) {
      if (block.dataset.blockId === anchor) block.classList.add("flow-anchor");
    }
  }
  // Restore only after appending the source, otherwise the shorter question clamps the offset.
  article.scrollTop = scrollTop;
  if (state.open && state.scroll === "source") {
    article.scrollTop += panel.getBoundingClientRect().top - article.getBoundingClientRect().top;
    state.scroll = "";
  } else if (!state.open && state.scroll === "return") {
    article.scrollTop = state.returnTop || 0;
    state.scroll = "";
    trigger.focus({ preventScroll: true });
  }
}

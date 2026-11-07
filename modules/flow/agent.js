import { applyPlan } from "./pages.js";
import { runAgent } from "../agent/kernel.js";

export const STUDY_SYSTEM = `你是学习流的自适应内核，不是讲解老师。目标是让 Billy 考试通过，并且真的懂。

Billy 是电信设计工程师：先看 read_learner 和笔记，再判断他哪里熟、哪里弱，不要根据职业预设他的基础。他不爱读大段文字，要靠题知道重点。

你只能调整题目出现的时机，以及让他重看已经读过的页。不要讲解。讲解由他提问时的另一个通道负责。做不到更好就不要改队列。先用工具读情况，再改。不要编造页 id 或题 id。未作答的题不能删除，未读原文不能丢或改顺序。

理由用一句中文，20 字以内，写给 Billy 看。`;

export const RULE_NO_KEY = "没配钥匙，按规则排";
export const RULE_ANTHROPIC = "这个模型不跑自适应";
export const RULE_OFFLINE = "这次没连上，按规则排";
export const RULE_REASONS = Object.freeze([RULE_NO_KEY, RULE_ANTHROPIC, RULE_OFFLINE]);

export function agentGate({ trigger, hasKey = false, provider = "" } = {}) {
  if (!hasKey) return { run: false, reason: RULE_NO_KEY };
  if (provider === "anthropic") return { run: false, reason: RULE_ANTHROPIC };
  if (trigger === "open" || trigger === "wrong" || trigger === "ask" || trigger === "streak") return { run: true, reason: "" };
  return { run: false, reason: "" };
}

function chars(value) {
  return Array.from(String(value ?? ""));
}

export function clipText(value, limit) {
  return chars(value).slice(0, limit).join("");
}

function redact(value, secret) {
  const text = String(value ?? "");
  if (!secret) return text;
  return text.split(secret).join("");
}

export function rememberNote(notes, text, now) {
  const body = chars(text).slice(0, 200).join("");
  if (!body) return { error: "笔记是空的" };
  const next = { ...(notes || {}) };
  const id = `n${now}-${Object.keys(next).length}`;
  next[id] = { text: body, at: now, updatedAt: now };
  const active = Object.entries(next)
    .filter(([, note]) => note && !note.removed)
    .sort((a, b) => (Number(a[1].at) || 0) - (Number(b[1].at) || 0) || (a[0] < b[0] ? -1 : 1));
  if (active.length > 30) {
    for (const [oldId, note] of active.slice(0, active.length - 30)) {
      next[oldId] = { ...note, removed: true, updatedAt: now };
    }
  }
  return { notes: next, id };
}

function userText(job) {
  if (job.kind === "ask") return `他刚问完。原话是：${job.extra.text || ""}`;
  if (job.kind === "wrong") return `他刚答错了题目 ${job.extra.id || ""}。先读学习者状态，再决定要不要改队列。`;
  if (job.kind === "streak") return "已经连续翻了 8 页，中间没有新的答错或提问。先读再决定要不要改队列。";
  return "刚打开这一块。先读学习者状态。做不到更好就不要改队列。";
}

function buildTools(host) {
  const secret = () => {
    try { return String(host.secret ? host.secret() : ""); }
    catch { return ""; }
  };
  const ctx = () => host.getContext(host.currentJob);
  return [
    {
      name: "read_learner",
      description: "读取这一块的进度、最近 30 条事件，以及你之前记下的笔记。",
      parameters: { type: "object", properties: {}, required: [] },
      run() {
        const current = ctx();
        const events = (current.events || []).slice(-30);
        const notes = (current.notes || []).filter((note) => note && !note.removed).slice(-30);
        return {
          chunkId: current.chunkId || "",
          seen: (current.seen || []).length,
          pages: (current.pages || []).length,
          cursor: current.cursor || 0,
          queueLength: (current.queue || []).length,
          events,
          notes
        };
      }
    },
    {
      name: "list_pages",
      description: "列出全部页和题：id、类型、前 40 字、状态，以及题挂在哪一页。",
      parameters: { type: "object", properties: {}, required: [] },
      run() {
        const current = ctx();
        const seen = new Set(current.seen || []);
        return {
          pages: (current.pages || []).map((page) => ({
            id: page.id,
            kind: page.kind,
            preview: page.preview || "",
            status: seen.has(page.id) ? "已读" : "未读"
          })),
          questions: (current.questions || []).map((question) => ({
            id: question.id,
            kind: question.kind,
            pageId: question.pageId || null,
            preview: question.preview || "",
            status: question.status || "未答"
          }))
        };
      }
    },
    {
      name: "read_page",
      description: "读取一页的完整原文，或一道题的题干和选项。",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      run(args) {
        const current = ctx();
        const page = (current.pages || []).find((item) => item.id === args.id);
        if (page) return { id: page.id, kind: page.kind, text: page.text || "" };
        const question = (current.questions || []).find((item) => item.id === args.id);
        if (question) return { id: question.id, stem: question.stem || "", options: question.options || [] };
        return { error: `没有 ${args.id}` };
      }
    },
    {
      name: "set_queue",
      description: "提交新的队列。items 是页 id 和题 id。reason 是给 Billy 看的一句中文，20 字以内。",
      parameters: {
        type: "object",
        properties: {
          items: { type: "array" },
          reason: { type: "string" }
        },
        required: ["items", "reason"]
      },
      run(args) {
        const reason = redact(String(args.reason || "").trim(), secret());
        if (!chars(reason).length) return { error: "请写一句 20 字以内的理由" };
        if (chars(reason).length > 20) return { error: "reason 要在 20 字以内" };
        if (!Array.isArray(args.items) || args.items.some((id) => typeof id !== "string")) return { error: "items 必须是字符串数组" };
        const current = ctx();
        const plan = applyPlan({ items: args.items, reason }, current.pages || [], current.questions || [], current.seen || [], current.queue || [], current.answered || []);
        if (!plan.ok) return { error: plan.error };
        host.saveQueue(plan.queue, reason, host.currentJob);
        return { ok: true, queue: plan.queue, fixes: plan.fixes, reason };
      }
    },
    {
      name: "write_note",
      description: "记下对这个学习者的判断。text 不超过 200 字。",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      run(args) {
        const text = redact(args.text, secret());
        if (typeof host.saveNote !== "function") return { error: "记不下" };
        const saved = rememberNote(host.notes ? host.notes() : {}, text, host.now ? host.now() : Date.now());
        if (saved.error) return { error: saved.error };
        host.saveNote(saved.notes);
        return { ok: true, id: saved.id };
      }
    }
  ];
}

export function createStudyRunner({
  getContext,
  getLlm,
  hasKey = () => false,
  provider = () => "",
  secret = () => "",
  saveQueue,
  saveNote,
  saveReason,
  saveError = () => {},
  notes = () => ({}),
  now = () => Date.now(),
  prepare,
  captureRun,
  maxSteps = 6,
  run = runAgent
} = {}) {
  if (typeof getContext !== "function" || typeof saveQueue !== "function" || typeof saveReason !== "function") {
    throw new TypeError("学习流内核缺少读写");
  }
  const wrongCounts = new Map();
  let running = false;
  let pending = null;
  let abortCurrent = null;
  const host = { getContext, saveQueue, saveNote, secret, notes, now, prepare, currentJob: null };

  function abort() {
    pending = null;
    if (abortCurrent) abortCurrent.abort();
  }

  async function runJob(job) {
    host.currentJob = job;
    if (typeof host.prepare === "function") host.prepare(job);
    const snap = typeof captureRun === "function" ? captureRun() : null;
    const key = snap ? String(snap.apiKey || "").trim() : "";
    const decision = agentGate({
      trigger: job.kind,
      hasKey: snap ? !!key : hasKey(),
      provider: snap ? String(snap.provider || "") : provider()
    });
    if (!decision.run) {
      if (decision.reason) saveReason(decision.reason, job);
      return;
    }
    const llm = typeof getLlm === "function" ? getLlm(snap, job) : null;
    if (typeof llm !== "function") {
      saveReason(RULE_OFFLINE, job);
      return;
    }
    const previousSecret = host.secret;
    if (snap) host.secret = () => key;
    const controller = new AbortController();
    abortCurrent = controller;
    try {
      await run({
        llm,
        system: STUDY_SYSTEM,
        messages: [{ role: "user", content: userText(job) }],
        tools: buildTools(host),
        maxSteps,
        signal: controller.signal
      });
    } catch (error) {
      if (!controller.signal.aborted) { saveError(error, job); saveReason(RULE_OFFLINE, job); }
    } finally {
      if (abortCurrent === controller) abortCurrent = null;
      host.secret = previousSecret;
    }
  }

  return {
    get running() { return running; },
    abort,
    async trigger(kind, extra) {
      if (kind === "wrong") {
        const chunk = extra?.chunkId || "";
        const count = (wrongCounts.get(chunk) || 0) + 1;
        wrongCounts.set(chunk, count % 2);
        if (count < 2) return { queued: false, skipped: true };
      }
      const job = { kind, extra: extra || {} };
      if (running) {
        pending = job;
        return { queued: true };
      }
      running = true;
      try {
        await runJob(job);
        while (pending) {
          const next = pending;
          pending = null;
          await runJob(next);
        }
      } finally {
        running = false;
      }
      return { queued: false };
    }
  };
}

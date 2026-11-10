import { memoryPrompt, learnerMemory } from "../agent/memory.js";
import { applyPlan } from "./pages.js";
import { runAgent } from "../agent/kernel.js";

export const STUDY_SYSTEM = `你是学习流的自适应内核，不是讲解老师。目标是让 Billy 考试通过，并且真的懂。

Billy 是电信设计工程师：先看 read_learner 和学习者档案，再判断他哪里熟、哪里弱，不要根据职业预设他的基础。他不爱读大段文字，要靠题知道重点。

你可以调整题目时机、回看原文，发现前置知识缺口时用 insert_lesson 插入补课。由你根据提问、错题和档案判断，不要机械插入。做不到更好就不要改队列。先用工具读情况，再改。不要编造页 id 或题 id。默认题不能删除；你追加的题可以删除。每页最多追加两道，一块最多追加原文页数的一半，未读原文不能丢或改顺序。

他问到题目或做错时，先 read_page 检查题目质量：位置记忆题、复述原文的解释、乱码提示，应 retire_question 或 rewrite_explanation。真题只能 flag_question，不能改答案。

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
      description: "读取这一块的进度、最近 30 条事件，学习者档案和整理后最多五条新笔记。",
      parameters: { type: "object", properties: {}, required: [] },
      run() {
        const current = ctx();
        const events = (current.events || []).filter(event => event.type !== "tool").slice(-30);
        const memory = learnerMemory(current.profile, current.notes, current.memoryState);
        return {
          chunkId: current.chunkId || "",
          seen: (current.seen || []).length,
          pages: (current.pages || []).length,
          cursor: current.cursor || 0,
          queueLength: (current.queue || []).length,
          queue: current.queue || [],
          questionOrigins: current.questionOrigins || {},
          events,
          ...memory
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
        if (question) return { id: question.id, stem: question.stem || "", options: question.options || [], explanation: question.explanation || "", answer: question.answer, kind: question.kind };
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
        const pendingLessons = (current.queue || []).filter(id => (current.lessons || []).some(l => l.id === id));
        const plan = applyPlan({ items: [...args.items, ...pendingLessons.filter(id => !args.items.includes(id))], reason }, current.pages || [], [...(current.questions || []), ...(current.lessons || [])], current.seen || [], current.queue || [], current.answered || [], current.questionOrigins || {});
        if (!plan.ok) return { error: plan.error };
        host.saveQueue(plan.queue, reason, host.currentJob);
        return { ok: true, queue: plan.queue, fixes: plan.fixes, reason };
      }
    },
    ...[
      ["insert_lesson", "发现前置知识缺口，在 before 页或题前插入补课。concept 只写概念名，12 字以内，不要写讲解。", { concept: {type:"string"}, reason: {type:"string"}, before: {type:"string"} }],
      ["retire_question", "停用有问题的考点题；真题不可停用。", { id: {type:"string"}, reason: {type:"string"} }],
      ["rewrite_explanation", "改写考点题的解释，不能改真题。", { id: {type:"string"}, text: {type:"string"} }],
      ["flag_question", "为题目记一条存疑，不改答案。", { id: {type:"string"}, reason: {type:"string"} }]
    ].map(([name, description, properties]) => ({ name, description,
      parameters: { type: "object", properties, required: Object.keys(properties) },
      run: args => host.performTool ? host.performTool(name, args, host.currentJob, host.llm, host.signal) : { error: "工具不可用" }
    })),
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
  performTool,
  saveTool = () => {},
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
  const host = { getContext, saveQueue, saveNote, secret, notes, now, prepare, performTool, currentJob: null };

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
    host.llm = llm; host.signal = controller.signal;
    const current = getContext(job);
    try {
      await run({
        llm,
        system: STUDY_SYSTEM + "\n" + memoryPrompt(current.profile, current.notes, current.memoryState),
        messages: [{ role: "user", content: userText(job) }],
        tools: buildTools(host),
        maxSteps,
        signal: controller.signal,
        onTool: entry => saveTool(JSON.parse(redact(JSON.stringify(entry), key || host.secret())), job)
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

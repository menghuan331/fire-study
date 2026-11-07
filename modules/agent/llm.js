import { QaError, failureDetails } from "../qa/errors.js";
import { chatCompletionsUrl } from "../qa/direct.js";

const AGENT_PROVIDERS = new Set(["deepseek", "dashscope", "openai-compatible"]);

function trimmed(value) {
  return String(value ?? "").trim();
}

function linkSignals(signal, timeoutMs) {
  const controller = new AbortController();
  let cause = "";
  const timer = setTimeout(() => {
    if (!cause) cause = "timeout";
    controller.abort();
  }, timeoutMs);
  const onAbort = () => {
    if (!cause) cause = "abort";
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
    timedOut: () => cause === "timeout"
  };
}

function toolSpecs(tools) {
  return (tools || []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} }
    }
  }));
}

function assistantMessage(message) {
  if (!message || typeof message !== "object") return { role: "assistant", content: null };
  return { ...message, role: message.role || "assistant" };
}

function readKeyOnce(getApiKey) {
  try {
    const value = getApiKey();
    if (value && typeof value.then === "function") {
      return Promise.resolve(value).then((item) => trimmed(item)).catch(() => "");
    }
    return Promise.resolve(trimmed(value));
  } catch {
    return Promise.resolve("");
  }
}

/** Anthropic is not an agent provider in this version. Returns null so the caller uses the rule queue. */
export function createAgentLlm({ provider, model, baseUrl, getApiKey = () => "", fetchImpl = globalThis.fetch, timeoutMs = 120000, onError = () => {} } = {}) {
  const name = trimmed(provider);
  const modelName = trimmed(model);
  const root = trimmed(baseUrl);
  if (!AGENT_PROVIDERS.has(name) || !modelName) return null;
  const timeout = Math.max(1, Number(timeoutMs) || 120000);
  const keyPromise = readKeyOnce(getApiKey);
  return async function llm({ system, messages, tools, signal }) {
    const key = await keyPromise;
    if (signal && signal.aborted) {
      const aborted = new Error("已取消");
      aborted.name = "AbortError";
      throw aborted;
    }
    if (!key) {
      const error = new Error("没有钥匙");
      error.code = "NO_KEY";
      throw error;
    }
    let url = "";
    try { url = chatCompletionsUrl(name, root); }
    catch {
      const error = new Error("地址不对");
      error.code = "NO_URL";
      throw error;
    }
    if (!url) {
      const error = new Error("地址不对");
      error.code = "NO_URL";
      throw error;
    }
    const body = {
      model: modelName,
      messages: [{ role: "system", content: String(system || "") }, ...(messages || [])],
      tools: toolSpecs(tools),
      max_tokens: 8192,
      temperature: 0.3
    };
    const linked = linkSignals(signal, timeout);
    let status = 0;
    let raw = "";
    let finish = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body), signal: linked.signal,
          credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"
        });
        status = response.status;
        raw = await response.text();
        if (!response.ok) {
          if (status === 400 && attempt === 0) {
            onError({ code: "HTTP", ...failureDetails(status, null, raw, key) });
            body.max_tokens = 4096; continue;
          }
          throw new QaError("HTTP", "模型请求失败");
        }
        let data;
        try { data = JSON.parse(raw); }
        catch { throw new QaError("BAD_RESPONSE", "模型没有返回"); }
        finish = data?.choices?.[0]?.finish_reason ?? null;
        const message = data?.choices?.[0]?.message;
        if (finish === "length" || (message && !String(message.content || "").trim() && !message.tool_calls?.length))
          throw new QaError("TRUNCATED");
        if (!message || typeof message !== "object") throw new QaError("BAD_RESPONSE", "模型没有返回");
        return assistantMessage(message);
      }
    } catch (error) {
      if (signal?.aborted) {
        const aborted = new QaError("ABORTED");
        aborted.name = "AbortError";
        throw aborted;
      }
      const safe = error instanceof QaError ? error : new QaError(linked.timedOut() ? "TIMEOUT" : "NETWORK");
      Object.assign(safe, failureDetails(status, finish, raw, key));
      throw safe;
    } finally { linked.done(); }
  };
}

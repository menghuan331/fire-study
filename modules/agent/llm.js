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
export function createAgentLlm({ provider, model, baseUrl, getApiKey = () => "", fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const name = trimmed(provider);
  const modelName = trimmed(model);
  const root = trimmed(baseUrl);
  if (!AGENT_PROVIDERS.has(name) || !modelName) return null;
  const timeout = Math.max(1, Number(timeoutMs) || 30000);
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
      temperature: 0.3
    };
    if (name === "deepseek") body.thinking = { type: "disabled" };
    const linked = linkSignals(signal, timeout);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: linked.signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
    } catch (error) {
      linked.done();
      if (signal && signal.aborted) {
        const aborted = new Error("已取消");
        aborted.name = "AbortError";
        throw aborted;
      }
      if (linked.timedOut() || (error && error.name === "AbortError")) {
        const timeoutError = new Error("超时");
        timeoutError.code = "TIMEOUT";
        throw timeoutError;
      }
      const network = new Error("网络不通");
      network.code = "NETWORK";
      throw network;
    }
    let raw = "";
    try { raw = await response.text(); }
    catch {
      linked.done();
      const network = new Error("网络不通");
      network.code = "NETWORK";
      throw network;
    }
    linked.done();
    if (!response.ok) {
      const error = new Error("模型请求失败");
      error.code = "HTTP";
      error.status = response.status;
      throw error;
    }
    let data = null;
    try { data = JSON.parse(raw); }
    catch {
      const error = new Error("模型没有返回");
      error.code = "BAD_RESPONSE";
      throw error;
    }
    const message = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!message || typeof message !== "object") {
      const error = new Error("模型没有返回");
      error.code = "BAD_RESPONSE";
      throw error;
    }
    return assistantMessage(message);
  };
}

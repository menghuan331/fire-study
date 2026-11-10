import { QaError, failureDetails } from "../qa/errors.js";
import { chatCompletionsUrl } from "../qa/direct.js";

const AGENT_PROVIDERS = new Set(["deepseek", "dashscope", "openai", "openai-compatible"]);

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
  // Keep original Responses items (including reasoning) within this run, out of saved progress.
  const responseOutputs = new WeakMap();
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
    let body = {
      model: modelName,
      messages: [{ role: "system", content: String(system || "") }, ...(messages || [])],
      tools: toolSpecs(tools),
      max_tokens: 8192,
      temperature: 0.3
    };
    // Plain JSON requests (profile consolidation, lesson generation/review) send no tools; some APIs reject an empty list.
    if (!body.tools.length) delete body.tools;
    const tokenField = name === "openai" ? "max_output_tokens" : "max_tokens";
    if (name === "openai") {
      // GPT-6 function calling requires Responses; QA still uses Chat Completions.
      url = "https://api.openai.com/v1/responses";
      const input = (messages || []).flatMap(message => {
        if (responseOutputs.has(message)) return responseOutputs.get(message);
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        const items = message.content ? [{ role: message.role, content: message.content }] : [];
        for (const call of message.tool_calls || []) items.push({ type: "function_call", call_id: call.id,
          name: call.function.name, arguments: call.function.arguments });
        return items;
      });
      body = { model: modelName, instructions: String(system || ""), input,
        tools: toolSpecs(tools).map(tool => ({ type: "function", ...tool.function, strict: false })),
        max_output_tokens: 8192, store: false };
      if (!body.tools.length) delete body.tools;
    }
    const linked = linkSignals(signal, timeout);
    let status = 0;
    let raw = "";
    let finish = null;
    let emptyRetried = false;
    let cancelListener;
    const canceled = new Promise((_, reject) => {
      cancelListener = () => reject(new QaError(linked.timedOut() ? "TIMEOUT" : "ABORTED"));
      if (linked.signal.aborted) cancelListener();
      else linked.signal.addEventListener("abort", cancelListener, { once: true });
    });
    const read = promise => Promise.race([promise, canceled]);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await read(fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body), signal: linked.signal,
          credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"
        }));
        status = response.status;
        raw = await read(response.text());
        if (!response.ok) {
          if (status === 400 && body[tokenField] === 8192) {
            onError({ code: "HTTP", ...failureDetails(status, null, raw, key) });
            body[tokenField] = 4096; continue;
          }
          throw new QaError("HTTP", "模型请求失败");
        }
        let data;
        try { data = JSON.parse(raw); }
        catch { throw new QaError("BAD_RESPONSE", "模型没有返回"); }
        finish = name === "openai"
          ? (data?.incomplete_details?.reason === "max_output_tokens" ? "length" : data?.status ?? null)
          : data?.choices?.[0]?.finish_reason ?? null;
        let message = data?.choices?.[0]?.message;
        if (name === "openai") {
          if (!Array.isArray(data?.output) || data.status === "failed") throw new QaError("BAD_RESPONSE", "模型没有返回");
          message = { role: "assistant", content: data.output.filter(item => item.type === "message")
            .flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join("") };
          const calls = data.output.filter(item => item.type === "function_call");
          if (calls.length) message.tool_calls = calls.map(call => ({ id: call.call_id, type: "function",
            function: { name: call.name, arguments: call.arguments } }));
        }
        if (finish === "length")
          throw new QaError("TRUNCATED");
        if (!message || typeof message !== "object") throw new QaError("BAD_RESPONSE", "模型没有返回");
        if (!String(message.content || "").trim() && !message.tool_calls?.length) {
          if (!emptyRetried) { emptyRetried = true; delete body.response_format; continue; }
          throw new QaError("EMPTY");
        }
        const result = assistantMessage(message);
        if (name === "openai") responseOutputs.set(result, data.output);
        return result;
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
    } finally { linked.signal.removeEventListener("abort", cancelListener); linked.done(); }
  };
}

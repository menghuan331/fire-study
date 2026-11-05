function parseArguments(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ok: true, value: raw };
  if (typeof raw !== "string" || !raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "参数必须是对象" };
    return { ok: true, value };
  } catch {
    return { ok: false, error: "参数无法解析" };
  }
}

function checkParameters(parameters, args) {
  if (!parameters || typeof parameters !== "object") return "";
  if (!args || typeof args !== "object" || Array.isArray(args)) return "参数必须是对象";
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") return `缺少 ${key}`;
  }
  const props = parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {};
  for (const [key, spec] of Object.entries(props)) {
    if (args[key] === undefined) continue;
    const type = spec && spec.type;
    if (type === "string" && typeof args[key] !== "string") return `${key} 应为字符串`;
    if (type === "number" && (typeof args[key] !== "number" || !Number.isFinite(args[key]))) return `${key} 应为数字`;
    if (type === "boolean" && typeof args[key] !== "boolean") return `${key} 应为布尔`;
    if (type === "array" && !Array.isArray(args[key])) return `${key} 应为数组`;
    if (type === "object" && (!args[key] || typeof args[key] !== "object" || Array.isArray(args[key]))) return `${key} 应为对象`;
  }
  return "";
}

async function runCall(tools, call) {
  const name = call && call.function && call.function.name;
  const tool = (tools || []).find((item) => item && item.name === name);
  if (!tool) return { error: `没有这个工具：${name || ""}` };
  const parsed = parseArguments(call.function && call.function.arguments);
  if (!parsed.ok) return { error: parsed.error };
  const problem = checkParameters(tool.parameters, parsed.value);
  if (problem) return { error: problem };
  try {
    return await tool.run(parsed.value);
  } catch (error) {
    return { error: error && error.message ? String(error.message) : "工具失败" };
  }
}

function textOf(message) {
  if (!message) return "";
  return typeof message.content === "string" ? message.content : "";
}

function aborted(signal, error) {
  return !!(signal && signal.aborted) || (error && error.name === "AbortError");
}

/**
 * Domain-neutral tool loop. The assistant message is appended as the model returned it, including tool_calls.
 * Bad arguments and tool failures go back to the model as tool results.
 */
export async function runAgent({ llm, system, messages, tools, maxSteps = 6, signal } = {}) {
  const thread = Array.isArray(messages) ? messages.slice() : [];
  const steps = [];
  const toolLog = [];
  const limit = Math.max(0, Number(maxSteps) || 0);
  if (typeof llm !== "function") throw new TypeError("llm 必须是函数");
  for (let step = 0; step < limit; step += 1) {
    if (signal && signal.aborted) return { text: textOf(steps.at(-1)), steps, toolLog, stopped: "aborted" };
    let message;
    try {
      message = await llm({ system, messages: thread, tools: tools || [], signal });
    } catch (error) {
      if (aborted(signal, error)) return { text: textOf(steps.at(-1)), steps, toolLog, stopped: "aborted" };
      throw error;
    }
    if (!message || typeof message !== "object") throw new TypeError("模型没有返回消息");
    thread.push(message);
    steps.push(message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (signal && signal.aborted) return { text: textOf(message), steps, toolLog, stopped: "aborted" };
    if (!calls.length) return { text: textOf(message), steps, toolLog, stopped: "done" };
    for (const call of calls) {
      if (signal && signal.aborted) return { text: textOf(message), steps, toolLog, stopped: "aborted" };
      const result = await runCall(tools, call);
      const toolMessage = { role: "tool", tool_call_id: call && call.id, content: JSON.stringify(result) };
      thread.push(toolMessage);
      toolLog.push({ id: call && call.id, name: call && call.function && call.function.name, result });
    }
  }
  return { text: textOf(steps.at(-1)), steps, toolLog, stopped: "maxSteps" };
}

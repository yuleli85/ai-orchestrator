import { config } from './config.js';

/**
 * 最小 LLM 客户端：OpenAI 兼容的 /chat/completions。
 *
 * 为什么不用 SDK：
 * 1. 零依赖，clone 下来 node server.js 就能跑，不用 npm install；
 * 2. 换供应商只是改 baseUrl，国产几家（DeepSeek / 千问 / 智谱 / Kimi）都兼容这个协议。
 *
 * 注意：DeepSeek V4 是推理模型，会先产出 reasoning_content 再产出 content。
 * max_tokens 给小了会被思考过程吃光，最终 content 为空且 finish_reason=length。
 */

export class LlmError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
  }
}

function endpoint() {
  return `${config.baseUrl}/chat/completions`;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  };
}

async function readError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  let msg = `HTTP ${res.status}`;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message || j?.message || msg;
  } catch {
    if (text) msg = `${msg}: ${text.slice(0, 300)}`;
  }
  return msg;
}

/**
 * 非流式调用，返回完整文本。
 */
export async function complete({ model, system, user, messages, tools, toolChoice, maxTokens = 4000, temperature = 0.5, timeout = config.requestTimeout, signal, effort }) {
  const body = {
    model,
    messages: messages || [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  // 推理模型支持 low/high/max；规划这类结构化任务用 low 能省一半时间，质量几乎不掉
  if (effort) body.reasoning_effort = effort;
  if (tools?.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new LlmError(await readError(res), res.status);

    const json = await res.json();
    const choice = json?.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? '';
    const toolCalls = (choice?.message?.tool_calls || []).map((tc) => {
      let args = {};
      try {
        args = JSON.parse(tc?.function?.arguments || '{}');
      } catch {
        args = { __raw: tc?.function?.arguments };
      }
      return {
        id: tc.id,
        name: tc?.function?.name,
        arguments: tc?.function?.arguments || '{}',
        args,
      };
    });
    return {
      content: typeof content === 'string' ? content : JSON.stringify(content),
      reasoning,
      toolCalls,
      finishReason: choice?.finish_reason,
      usage: json?.usage || {},
      model: json?.model || model,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new LlmError(`模型响应超时（${Math.round(timeout / 1000)}s）`, 408);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式调用。onDelta(text) 拿到增量正文，onReasoning(text) 拿到增量思考。
 * 返回 { content, reasoning, usage }。
 */
export async function stream({ model, system, user, messages, maxTokens = 4000, temperature = 0.5, timeout = config.requestTimeout, onDelta, onReasoning, signal, effort }) {
  const body = {
    model,
    messages: messages || [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (effort) body.reasoning_effort = effort;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  let content = '';
  let reasoning = '';
  let usage = {};
  let finishReason = null;

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new LlmError(await readError(res), res.status);
    if (!res.body) throw new LlmError('响应没有 body，无法流式读取', 502);

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE 以空行分隔事件；这里按行处理并对残缺行做缓冲
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // 半包，忽略；下一个 chunk 会补齐完整事件
        }
        if (evt.usage) usage = evt.usage;
        const choice = evt?.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const dContent = choice?.delta?.content;
        if (typeof dContent === 'string' && dContent) {
          content += dContent;
          onDelta?.(dContent);
        }
        const dReason = choice?.delta?.reasoning_content;
        if (typeof dReason === 'string' && dReason) {
          reasoning += dReason;
          onReasoning?.(dReason);
        }
      }
    }

    return { content, reasoning, usage, finishReason, model };
  } catch (err) {
    if (err.name === 'AbortError') throw new LlmError(`模型响应超时（${Math.round(timeout / 1000)}s）`, 408);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从模型输出里抠 JSON。模型偶尔会套 markdown 代码块或加前言，这里做兜底。
 */
export function extractJson(text) {
  if (!text) throw new Error('模型返回为空');
  let s = String(text).trim();

  // 去掉 ```json ... ``` 包裹
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      /* fall through */
    }
  }

  // 从第一个 { 扫到与之配对的 }，跳过字符串内的括号
  const start = s.indexOf('{');
  if (start < 0) throw new Error('模型输出里找不到 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (e) {
          throw new Error(`JSON 解析失败：${e.message}`);
        }
      }
    }
  }
  throw new Error('模型输出的 JSON 不完整（缺少收尾大括号）');
}

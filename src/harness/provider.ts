import { z } from 'zod';
import type { Completion, ModelConfig, ModelMessage, ModelProvider, ToolDefinition } from '../shared/types';

const configSchema = z.object({ baseUrl: z.string().url().max(2048), model: z.string().trim().min(1).max(200), apiKey: z.string().trim().max(10000) });
export function validateConfig(input: ModelConfig): ModelConfig {
  const config = configSchema.parse(input);
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不能包含凭据、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('模型地址需要 HTTPS；本机模型可使用 localhost HTTP。');
  config.baseUrl = url.toString().replace(/\/$/, '');
  return config;
}
const responseSchema = z.object({
  choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({
    content: z.string().nullable().optional(), refusal: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ id: z.string().min(1).max(200), type: z.literal('function'), function: z.object({ name: z.string().max(100), arguments: z.string().max(200000) }) })).max(8).optional(),
  }) })).min(1), usage: z.object({ total_tokens: z.number().optional() }).optional(),
});
export class ChatProvider implements ModelProvider {
  constructor(private getConfig: () => ModelConfig | null) {}
  async complete(messages: ModelMessage[], tools: ToolDefinition[], signal: AbortSignal, maxTokens: number): Promise<Completion> {
    const config = this.getConfig();
    if (!config) throw new Error('请先在模型设置中配置 API 地址与模型。');
    const checked = validateConfig(config);
    const endpoint = checked.baseUrl.endsWith('/chat/completions') ? checked.baseUrl : `${checked.baseUrl}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
      headers: { 'Content-Type': 'application/json', ...(checked.apiKey ? { Authorization: `Bearer ${checked.apiKey}` } : {}) },
      body: JSON.stringify({ model: checked.model, messages, stream: false, max_completion_tokens: Math.min(Math.max(maxTokens, 128), 8192), ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`模型请求失败（HTTP ${response.status}）。请检查地址、模型、额度和工具调用兼容性。`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('模型返回了空响应。');
    const chunks: Uint8Array[] = []; let total = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > 2 * 1024 * 1024) throw new Error('模型响应过大，已停止读取。'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    signal.throwIfAborted();
    let data: z.infer<typeof responseSchema>;
    try { data = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { throw new Error('模型响应不符合 Chat Completions 工具协议。'); }
    const choice = data.choices[0];
    if (choice.finish_reason === 'length') throw new Error('模型输出达到长度限制，本次结果尚不完整。');
    if (choice.message.refusal || choice.finish_reason === 'content_filter') throw new Error('模型未执行本次请求，请调整节点要求。');
    return { content: choice.message.content ?? '', toolCalls: choice.message.tool_calls ?? [], tokens: data.usage?.total_tokens };
  }
}

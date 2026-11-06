import crypto from 'node:crypto';

async function request(model, key, route, { body, signal, timeoutSeconds = 120 } = {}) {
  const response = await fetch(model.baseUrl + route, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(timeoutSeconds * 1000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`模型接口返回 HTTP ${response.status}，请检查地址、密钥、配额及模型权限`);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new Error('模型响应超过 8 MB 上限');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('模型接口未返回有效 JSON'); }
}

export async function chat(model, key, messages, tools, options) {
  const body = { model: model.model, messages, stream: false, max_tokens: model.maxTokens };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  if (model.thinking !== 'default') body.thinking = { type: model.thinking };
  const response = await request(model, key, '/chat/completions', { ...options, body });
  if (response.error) throw new Error('模型接口返回错误对象');
  const choice = response.choices?.[0];
  if (!choice?.message || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('模型响应未完整结束，可能达到输出上限或被拒绝');
  if (choice.message.role !== 'assistant') throw new Error('模型接口返回的消息角色无效');
  if (choice.message.refusal) throw new Error('模型拒绝了该请求');
  if (choice.message.tool_calls?.length > 16) throw new Error('单轮工具调用过多');
  return { message: choice.message, finishReason: choice.finish_reason, returnedModel: response.model, usage: response.usage || {} };
}

export async function probe(model, key, options) {
  const catalog = await request(model, key, '/models', options);
  if (!catalog.data?.some(item => item.id === model.model)) throw new Error('模型 ID 不在 /models 目录中，请填写平台返回的完整 ID');
  const tools = [{ type: 'function', function: {
    name: 'get_probe_marker', description: 'Return the one-time connection test marker.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  } }];
  const messages = [{ role: 'user', content: 'Call get_probe_marker once. After receiving its result, respond with only the exact marker. Do not guess the marker.' }];
  const first = await chat(model, key, messages, tools, options);
  const calls = first.message.tool_calls;
  if (calls?.length !== 1 || calls[0].function?.name !== 'get_probe_marker' || !calls[0].id) throw new Error('接口未完成函数工具调用，不能启用执行型任务');
  const marker = `BAIGONG_${crypto.randomUUID()}`;
  messages.push(first.message, { role: 'tool', tool_call_id: calls[0].id, content: marker });
  const second = await chat(model, key, messages, undefined, options);
  if (second.message.content?.trim() !== marker || second.message.tool_calls?.length) throw new Error('工具结果回传验证失败');
  return { ok: true, tools: true, returnedModel: second.returnedModel || null,
    modelMatched: second.returnedModel === model.model, usage: [first.usage, second.usage] };
}

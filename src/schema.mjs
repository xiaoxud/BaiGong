import { z } from 'zod';

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const modelSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  provider: z.enum(['deepseek', 'openai-compatible']).default('openai-compatible'),
  baseUrl: z.string().url().transform(normalizeUrl),
  model: z.string().trim().min(1).max(150).regex(/^\S+$/),
  description: z.string().max(1500).default(''),
  enabled: z.boolean().default(true),
  thinking: z.enum(['default', 'enabled', 'disabled']).default('default'),
  maxTokens: z.number().int().min(256).max(16384).default(4096),
}).strict();

export const settingsSchema = z.object({
  enabled: z.boolean(),
  concurrency: z.number().int().min(1).max(8),
  maxSteps: z.number().int().min(2).max(40),
  timeoutSeconds: z.number().int().min(10).max(600),
  maxRevisions: z.number().int().min(0).max(5),
}).strict();

export const taskSchema = z.object({
  modelId: idSchema,
  title: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(40000),
  acceptance: z.string().trim().min(1).max(10000),
  assignmentReason: z.string().trim().min(1).max(1500),
  files: z.array(z.string().min(1).max(500)).max(100).default([]),
  mode: z.enum(['read-only', 'edit-files']).default('read-only'),
}).strict();

export function normalizeUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含凭据、查询参数或片段');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须使用 HTTPS');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('远程 API 地址必须使用 HTTPS');
  }
  if (/\/(chat\/completions|responses|models)\/?$/.test(url.pathname)) throw new Error('请填写 API 根地址，不要填写具体接口地址');
  return url.href.replace(/\/+$/, '');
}

export const defaults = () => ({
  version: 1,
  settings: { enabled: false, concurrency: 2, maxSteps: 16, timeoutSeconds: 120, maxRevisions: 2 },
  models: [],
});

export function parse(schema, input) {
  const value = schema.safeParse(input);
  if (!value.success) throw new Error(value.error.issues.map(i => `${i.path.join('.') || '参数'}: ${i.message}`).join('; '));
  return value.data;
}

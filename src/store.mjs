import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaults, modelSchema, settingsSchema, parse } from './schema.mjs';
import { privateDirectory, readJson, writeJson } from './files.mjs';
import { Vault } from './vault.mjs';

export class Store {
  constructor(workspace, { secretsDirectory } = {}) {
    this.workspace = fs.realpathSync(workspace);
    this.root = privateDirectory(path.join(this.workspace, '.work'));
    this.tasksRoot = privateDirectory(path.join(this.root, 'tasks'));
    this.configFile = path.join(this.root, 'config.json');
    this.vault = new Vault(secretsDirectory);
    this.namespace = crypto.createHash('sha256').update(this.workspace).digest('hex').slice(0, 20);
    if (!fs.existsSync(this.configFile)) writeJson(this.configFile, defaults());
    this.config();
  }
  config() {
    const config = readJson(this.configFile);
    if (config.version !== 1 || !Array.isArray(config.models)) throw new Error('不支持的百工配置格式');
    parse(settingsSchema, config.settings);
    config.models.forEach(({ test, ...model }) => parse(modelSchema, model));
    return config;
  }
  publicConfig() {
    const config = this.config();
    return { ...config, workspace: this.workspace, workDirectory: this.root,
      models: config.models.map(model => ({ ...model, hasKey: this.vault.has(this.credentialId(model.id)) })) };
  }
  credentialId(id) { return `${this.namespace}-${id}`; }
  key(id) { return this.vault.get(this.credentialId(id)); }
  settings(patch) {
    const config = this.config();
    config.settings = parse(settingsSchema, { ...config.settings, ...patch });
    writeJson(this.configFile, config);
    return this.publicConfig();
  }
  saveModel(input, apiKey) {
    const model = parse(modelSchema, input);
    this.assertNoKey(JSON.stringify(model));
    if (apiKey && JSON.stringify(model).includes(apiKey)) throw new Error('模型描述或地址中包含 API Key，请仅在密钥字段填写');
    const config = this.config();
    const old = config.models.find(m => m.id === model.id);
    if (!old && config.models.length >= 50) throw new Error('最多配置 50 个模型');
    const sameProtocol = old && ['baseUrl', 'model', 'provider', 'thinking'].every(k => old[k] === model[k]) && !apiKey;
    if (sameProtocol && old.test) model.test = old.test;
    if (apiKey) this.vault.set(this.credentialId(model.id), apiKey);
    if (!this.vault.has(this.credentialId(model.id))) throw new Error('首次保存请填写 API Key');
    config.models = [...config.models.filter(m => m.id !== model.id), model];
    writeJson(this.configFile, config);
    return this.publicConfig();
  }
  removeModel(id) {
    const config = this.config();
    config.models = config.models.filter(m => m.id !== id);
    writeJson(this.configFile, config);
    this.vault.remove(this.credentialId(id));
    return this.publicConfig();
  }
  model(id) {
    const model = this.config().models.find(m => m.id === id);
    if (!model) throw new Error('找不到模型');
    return model;
  }
  recordTest(id, fingerprint, result) {
    const config = this.config();
    const model = config.models.find(m => m.id === id);
    if (!model || this.fingerprint(model) !== fingerprint) throw new Error('测试期间模型配置已变化，请重新测试');
    model.test = { ...result, fingerprint, at: new Date().toISOString() };
    writeJson(this.configFile, config);
  }
  fingerprint(model) {
    return crypto.createHash('sha256').update(JSON.stringify([model.baseUrl, model.model, model.provider, model.thinking, this.key(model.id)])).digest('hex');
  }
  assertNoKey(text) {
    for (const model of this.config().models) {
      const key = this.key(model.id);
      if (key && text.includes(key)) throw new Error('任务或产出包含已配置的 API Key，已阻止');
    }
  }
  taskDirectory(id) {
    if (!/^task-[a-f0-9-]{36}$/.test(id)) throw new Error('任务 ID 无效');
    const directory = path.join(this.tasksRoot, id);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('任务目录不能是链接');
    return directory;
  }
  saveTask(task) { writeJson(path.join(this.taskDirectory(task.id), 'task.json'), task); }
  getTask(id) {
    const task = readJson(path.join(this.taskDirectory(id), 'task.json'));
    if (!task) throw new Error('找不到任务');
    return task;
  }
  tasks() {
    return fs.readdirSync(this.tasksRoot).filter(id => /^task-[a-f0-9-]{36}$/.test(id))
      .map(id => this.getTask(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

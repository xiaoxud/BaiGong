import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fixture, temporary, mockApi, assignment, until, secret, completion, functionCall } from './helpers.mjs';
import { Store } from '../src/store.mjs';
import { TaskManager } from '../src/tasks.mjs';
import { checkedPath, readText, writeText } from '../src/files.mjs';
import { normalizeUrl } from '../src/schema.mjs';
import { createService } from '../src/service.mjs';

test('默认关闭；凭据加密保存且不会出现在公开配置或任务输入', async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.publicConfig().settings.enabled, false);
    assert.throws(()=>f.manager.create(assignment()), /关闭/);
    assert.equal(f.store.key('worker'), secret);
    assert.ok(!JSON.stringify(f.store.publicConfig()).includes(secret));
    assert.ok(!fs.readFileSync(f.store.configFile,'utf8').includes(secret));
    assert.ok(!fs.readFileSync(f.store.vault.file,'utf8').includes(secret));
    await f.ready();
    assert.throws(()=>f.manager.create(assignment({ instructions: secret })), /API Key/);
    const other = new Store(f.workspace, { secretsDirectory: f.secretsDirectory });
    assert.equal(other.key('worker'),secret);
  } finally { await f.close(); }
});

test('真实 HTTP 工具往返、文件执行、产出审核与限次返工', async () => {
  const f = await fixture();
  try {
    await f.ready();
    assert.equal(f.upstream.requests.length,3);
    assert.ok(f.upstream.requests.every(r=>r.authorization === `Bearer ${secret}`));
    assert.ok(f.store.model('worker').test.tools);
    f.manager.setSettings({ maxRevisions: 1 });
    const created = f.manager.create(assignment());
    await until(()=>f.store.getTask(created.id).status==='awaiting-review');
    const task = f.store.getTask(created.id);
    assert.equal(task.steps,3);
    assert.equal(task.usage.completionTokens,15);
    assert.equal(fs.readFileSync(path.join(f.workspace,'src/input.txt'),'utf8'),'hello baigong');
    assert.equal(fs.existsSync(path.join(f.workspace,'output.txt')),false);
    assert.equal(f.manager.artifact(task.id,'output.txt').content,'HELLO BAIGONG');
    assert.equal(task.artifacts.find(a=>a.path==='output.txt').status,'added');
    assert.ok(!JSON.stringify(task).includes('private mock reasoning'));
    const roundTrip = f.upstream.requests.filter(r=>r.body?.messages?.some(m=>m.role==='tool'));
    assert.ok(roundTrip.some(r=>r.body.messages.some(m=>m.reasoning_content==='private mock reasoning')));
    f.manager.review(task.id,'request-changes','再确认大写输出，保留其他文件。');
    await until(()=>f.store.getTask(task.id).status==='awaiting-review');
    assert.throws(()=>f.manager.review(task.id,'request-changes','再次返工'),/上限/);
    const reviewed = f.manager.review(task.id,'approve','主智能体已读取 output.txt，内容与独立计算的大写结果相符。');
    assert.equal(reviewed.status,'approved');
    assert.equal(fs.existsSync(path.join(f.workspace,'output.txt')),false);
    assert.equal(reviewed.reviews.length,2);
  } finally { await f.close(); }
});

test('路径穿越、Windows ADS、凭据文件、链接和只读权限受到限制', async () => {
  const temp = temporary();
  try {
    for (const p of ['../escape.txt','/absolute','C:/escape','a\\b','a:stream','.env','.env.local','.npmrc','.netrc','id_rsa','.git/config','.work/config.json','secrets.json','key.pem','CON.txt','folder./x']) {
      assert.throws(()=>checkedPath(temp.workspace,p),undefined,p);
    }
    fs.mkdirSync(path.join(temp.root,'external'));
    fs.writeFileSync(path.join(temp.root,'external','outside.txt'),'private');
    fs.symlinkSync(path.join(temp.root,'external'),path.join(temp.workspace,'linked'),process.platform==='win32'?'junction':'dir');
    assert.throws(()=>readText(temp.workspace,'linked/outside.txt'),/链接|联接/);
    assert.throws(()=>writeText(temp.workspace,'linked/new.txt','bad'),/链接|联接/);
    assert.equal(fs.existsSync(path.join(temp.root,'external','new.txt')),false);
  } finally { temp.cleanup(); }
  const f = await fixture();
  try {
    await f.ready();
    const created = f.manager.create(assignment({ mode:'read-only' }));
    assert.throws(()=>f.manager.tool(created,'write_file',{path:'unexpected.txt',content:'x'}),/不可用/);
    await until(()=>f.store.getTask(created.id).status==='awaiting-review');
    assert.equal(f.store.getTask(created.id).steps,2);
    assert.ok(f.store.getTask(created.id).artifacts.every(a=>a.status==='unchanged'));
  } finally { await f.close(); }
});

test('多个第三方端点分别路由，各任务产出目录独立', async()=>{
  const f=await fixture();
  const second=await mockApi();
  try {
    await f.ready();
    f.store.saveModel({id:'second',name:'另一平台',baseUrl:second.baseUrl,model:'mock-model',description:'独立平台和凭据'},'different-platform-key-123');
    await f.manager.testModel('second');
    const a=f.manager.create(assignment());
    const b=f.manager.create(assignment({modelId:'second'}));
    await until(()=>[a,b].every(t=>f.store.getTask(t.id).status==='awaiting-review'));
    assert.notEqual(f.store.taskDirectory(a.id),f.store.taskDirectory(b.id));
    assert.equal(f.manager.artifact(a.id,'output.txt').content,'HELLO BAIGONG');
    assert.equal(f.manager.artifact(b.id,'output.txt').content,'HELLO BAIGONG');
    assert.ok(second.requests.every(r=>r.authorization==='Bearer different-platform-key-123'));
    assert.ok(f.upstream.requests.every(r=>r.authorization===`Bearer ${secret}`));
  } finally { await f.close(); await second.close(); }
});

test('取消会阻止迟到的模型响应和后续写文件', async () => {
  const f = await fixture({ delay:300 });
  try {
    await f.ready();
    const task = f.manager.create(assignment());
    await until(()=>f.upstream.requests.length>=4);
    f.manager.cancel(task.id);
    await until(()=>f.manager.controllers.size===0);
    assert.equal(f.store.getTask(task.id).status,'cancelled');
    assert.equal(fs.existsSync(path.join(f.store.taskDirectory(task.id),'workspace','output.txt')),false);
    assert.equal(f.store.getTask(task.id).events.filter(e=>e.type==='tool').length,0);
  } finally { await f.close(); }
});

test('总开关关闭取消排队任务；在用模型不能改配置', async () => {
  const f = await fixture({ delay:100 });
  try {
    await f.ready(); f.manager.setSettings({ concurrency:1 });
    const first = f.manager.create(assignment());
    const second = f.manager.create(assignment({title:'排队的任务'}));
    assert.equal(f.store.getTask(second.id).status,'queued');
    assert.throws(()=>f.manager.modelIdle('worker'),/执行任务/);
    f.manager.setSettings({enabled:false});
    assert.equal(f.store.getTask(second.id).status,'cancelled');
    assert.throws(()=>f.manager.create(assignment()),/关闭/);
    await until(()=>f.store.getTask(first.id).status==='awaiting-review');
    assert.equal(f.store.getTask(first.id).status,'awaiting-review');
  } finally { await f.close(); }
});

test('达到调用上限或空结果时不会伪装为成功', async () => {
  const f = await fixture({ handle(req, body) {
    if (body?.messages?.[0]?.role==='system') return functionCall('read_file',{path:'src/input.txt'});
  } });
  try {
    await f.ready(); f.manager.setSettings({maxSteps:2});
    const task = f.manager.create(assignment());
    await until(()=>f.store.getTask(task.id).status==='failed');
    assert.match(f.store.getTask(task.id).error,/轮数上限/);
    assert.throws(()=>f.manager.review(task.id,'approve','okay'),/尚未提交/);
  } finally { await f.close(); }
  const empty = await fixture({handle(req,body) { if(body?.messages?.[0]?.role==='system') return completion({content:''}); }});
  try {
    await empty.ready(); const task=empty.manager.create(assignment());
    await until(()=>empty.store.getTask(task.id).status==='failed');
    assert.match(empty.store.getTask(task.id).error,/空结果/);
  } finally { await empty.close(); }
});

test('重启不会声称恢复了尚未完成的任务', async () => {
  const f=await fixture();
  try {
    await f.ready();
    const task=f.manager.create(assignment());
    f.manager.cancel(task.id);
    await until(()=>f.manager.controllers.size===0);
    const persisted=f.store.getTask(task.id); persisted.status='running'; f.store.saveTask(persisted);
    new TaskManager(f.store);
    assert.equal(f.store.getTask(task.id).status,'failed');
    assert.match(f.store.getTask(task.id).error,/上次退出/);
  } finally { await f.close(); }
});

test('不同项目使用独立凭据；换 API/模型参数需重新验证', async () => {
  const f=await fixture();
  const other=temporary();
  try {
    await f.ready();
    const b=new Store(other.workspace,{secretsDirectory:f.secretsDirectory});
    assert.equal(b.key('worker'),null);
    const {test:oldTest,...model}=f.store.model('worker');
    f.store.saveModel({...model,description:'只修改描述'},undefined);
    assert.ok(f.store.model('worker').test.ok);
    f.store.saveModel({...model,model:'different-model'},undefined);
    assert.equal(f.store.model('worker').test,undefined);
    assert.throws(()=>f.manager.create(assignment()),/连接和工具/);
  } finally { await f.close(); other.cleanup(); }
});

test('模型目录错误、工具不支持、接口重定向均明确失败', async () => {
  for (const kind of ['missing','no-tools','redirect']) {
    const f=await fixture({handle(req,body,res) {
      if (kind==='missing' && req.url==='/models') return {data:[]};
      if (kind==='no-tools' && body?.tools?.[0]?.function.name==='get_probe_marker') return completion({content:'I cannot call tools'});
      if (kind==='redirect') { res.writeHead(302,{Location:'http://127.0.0.1:1/steal'}); res.end(); }
    }});
    try { await assert.rejects(()=>f.manager.testModel('worker')); assert.equal(f.store.model('worker').test.ok,false); }
    finally { await f.close(); }
  }
  assert.throws(()=>normalizeUrl('http://remote.example/v1'),/HTTPS/);
  assert.throws(()=>normalizeUrl('https://api.example/v1/chat/completions'),/根地址/);
});

test('本地 HTTP 面板鉴权、Origin、Host、静态文件和关闭流程', async () => {
  const temp=temporary();
  const service=await createService({...temp,publish:false});
  try {
    const {origin,token}=service.connection;
    const unauth=await fetch(origin+'/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(unauth.status,401);
    const forbidden=await fetch(origin+'/api/call',{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});
    assert.equal(forbidden.status,403);
    const badHost=await new Promise((resolve,reject)=>{
      const request=http.get(origin+'/api/health',{headers:{Authorization:`Bearer ${token}`,Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});
      request.on('error',reject);
    });
    assert.equal(badHost,403);
    const config=await fetch(origin+'/api/call',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'get_state'})});
    assert.equal(config.status,200);
    assert.equal((await config.json()).result.config.settings.enabled,false);
    const html=await fetch(origin+'/');
    assert.match(await html.text(),/百工/);
    assert.match(html.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
    assert.equal((await fetch(origin+'/app.js')).status,200);
    assert.equal((await fetch(origin+'/styles.css')).status,200);
    assert.equal((await fetch(origin+'/.work/config.json')).status,404);
  } finally { await service.close(); temp.cleanup(); }
});

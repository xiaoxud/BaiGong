import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createService } from '../src/service.mjs';
import { temporary, mockApi, assignment, until, secret } from './helpers.mjs';

test('官方 MCP client 完成发现、分配、文件审核；内嵌 UI 资源无访问令牌', async () => {
  const temp=temporary();
  const upstream=await mockApi();
  const service=await createService(temp);
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bin/baigong.mjs',import.meta.url)),'mcp','--workspace',temp.workspace,'--secrets-dir',temp.secretsDirectory],stderr:'pipe'});
  const client=new Client({name:'baigong-integration-test',version:'1.0.0'});
  try {
    service.store.saveModel({id:'worker',name:'协议工匠',provider:'deepseek',baseUrl:upstream.baseUrl,model:'mock-model'},secret);
    await service.manager.testModel('worker'); service.manager.setSettings({enabled:true});
    await client.connect(transport);
    const tools=await client.listTools();
    assert.ok(tools.tools.some(t=>t.name==='baigong_start_task'));
    assert.deepEqual(tools.tools.find(t=>t.name==='baigong_save_model')._meta.ui.visibility,['app']);
    assert.ok(!tools.tools.some(t=>/read.*key/.test(t.name)));
    const list=await client.callTool({name:'baigong_list_models',arguments:{}});
    assert.equal(list.structuredContent.data.models[0].ready,true);
    assert.ok(!JSON.stringify(list).includes(secret));
    const result=await client.callTool({name:'baigong_start_task',arguments:assignment()});
    assert.ok(!result.isError,JSON.stringify(result));
    const id=result.structuredContent.data.id;
    await until(()=>service.store.getTask(id).status==='awaiting-review');
    const artifact=await client.callTool({name:'baigong_get_artifact',arguments:{id,path:'output.txt'}});
    assert.equal(artifact.structuredContent.data.content,'HELLO BAIGONG');
    const review=await client.callTool({name:'baigong_review_task',arguments:{id,decision:'approve',notes:'通过 MCP 读取文件并核对了大写结果，主项目未变化。'}});
    assert.equal(review.structuredContent.data.status,'approved');
    const resource=await client.readResource({uri:'ui://baigong/dashboard-v1.html'});
    assert.match(resource.contents[0].mimeType,/mcp-app/);
    assert.ok(resource.contents[0].text.includes('BAIGONG_EMBEDDED=true'));
    assert.ok(!resource.contents[0].text.includes(service.connection.token));
    assert.ok(!resource.contents[0].text.includes(secret));
    assert.ok(!fs.existsSync(path.join(temp.workspace,'output.txt')));
  } finally { await client.close(); await upstream.close(); await service.close(); temp.cleanup(); }
});

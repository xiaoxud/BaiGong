import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createService, dispatch } from '../src/service.mjs';
import { uiHtml } from '../src/mcp.mjs';
import { temporary, mockApi, secret, until } from './helpers.mjs';

test('浏览器完成添加模型、连接测试、启用、执行、审核及窄屏布局', async () => {
  const temp=temporary();
  const upstream=await mockApi();
  const service=await createService({...temp,publish:false});
  const browser=await chromium.launch({headless:true,...(process.env.BAIGONG_BROWSER ? {executablePath:process.env.BAIGONG_BROWSER} : process.platform==='win32'?{channel:'msedge'}:{})});
  const page=await browser.newPage({viewport:{width:1365,height:1000}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
  page.on('dialog',dialog=>dialog.accept());
  const output=path.resolve('.work','qa'); fs.mkdirSync(output,{recursive:true});
  try {
    await page.goto(service.url);
    await page.getByRole('heading',{name:'让各有所长，协同成事。'}).waitFor();
    assert.ok(!page.url().includes('token='));
    await page.screenshot({path:path.join(output,'models-empty.png'),fullPage:true});
    await page.getByRole('button',{name:'＋ 添加模型',exact:true}).click();
    await page.getByLabel('显示名称').fill('DeepSeek · 代码工匠');
    await page.getByLabel('模型标识').fill('worker');
    await page.getByLabel('完整模型 ID').fill('mock-model');
    await page.getByLabel('API 根地址').fill(upstream.baseUrl);
    await page.getByLabel('API Key',{exact:false}).fill(secret);
    await page.getByLabel('能力描述').fill('擅长代码实现、问题分析和文件处理。');
    await page.getByRole('button',{name:'保存模型',exact:true}).click();
    await page.getByRole('heading',{name:'DeepSeek · 代码工匠',exact:true}).waitFor();
    await page.getByRole('button',{name:'测试连接',exact:true}).click();
    await page.getByText('连接已验证',{exact:true}).waitFor();
    assert.equal(upstream.requests.length,3);
    await page.getByRole('switch',{name:'启用百工协作'}).click();
    await until(()=>service.store.config().settings.enabled);
    await page.screenshot({path:path.join(output,'models-configured.png'),fullPage:true});
    await page.getByRole('navigation').getByRole('button',{name:/任务中心/}).click();
    await page.getByRole('button',{name:'＋ 创建任务',exact:true}).click();
    await page.getByLabel('执行权限').selectOption('edit-files');
    await page.getByLabel('任务名称').fill('将示例文件转为大写');
    await page.getByLabel('任务内容',{exact:true}).fill('读取 src/input.txt，将大写内容写入 output.txt。');
    await page.getByLabel('验收标准',{exact:true}).fill('output.txt 的内容为 HELLO BAIGONG。');
    await page.getByLabel('选择该模型的原因').fill('已通过工具测试，适合明确的文件转换任务。');
    await page.getByLabel('输入文件（每行一个相对路径，可留空）').fill('src/input.txt');
    await page.getByRole('button',{name:'分配并执行',exact:true}).click();
    await page.getByLabel('审核依据 / 返工要求').waitFor({timeout:15000});
    await page.getByRole('button',{name:'output.txt · 新增',exact:true}).click();
    await page.locator('.code.current').filter({hasText:'HELLO BAIGONG'}).waitFor();
    await page.screenshot({path:path.join(output,'task-review.png'),fullPage:true});
    await page.getByLabel('审核依据 / 返工要求').fill('已对照原始文件检查大写结果；主项目未被覆盖。');
    await page.getByRole('button',{name:'审核通过',exact:true}).click();
    await until(()=>service.store.tasks()[0].status==='approved');
    await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
    await page.getByRole('navigation').getByRole('button',{name:/协作设置/}).click();
    await page.getByLabel('同时执行任务数').fill('3');
    await page.getByRole('button',{name:'保存协作设置',exact:true}).click();
    await until(()=>service.store.config().settings.concurrency===3);
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('navigation').getByRole('button',{name:/模型管理/}).click();
    await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    assert.equal(overflow,false);
    assert.deepEqual(errors,[]);
    assert.ok(!fs.existsSync(path.join(temp.workspace,'output.txt')));
    console.log(`界面截图：${output}`);
  } finally { await browser.close(); await service.close(); await upstream.close(); temp.cleanup(); }
});

test('同一配置界面通过官方 MCP Apps 桥在 iframe 内运行', async()=>{
  const temp=temporary();
  const service=await createService({...temp,publish:false});
  const browser=await chromium.launch({headless:true,...(process.env.BAIGONG_BROWSER?{executablePath:process.env.BAIGONG_BROWSER}:process.platform==='win32'?{channel:'msedge'}:{})});
  const hostScript=await build({absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),entryPoints:['test/embedded-host.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const host=http.createServer(async(req,res)=>{
    if(req.url==='/host-call') {
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));
      try {
        const data=await dispatch(service.store,service.manager,input.name.replace(/^baigong_/,''),input.arguments);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({structuredContent:{data},content:[]}));
      }catch(error){res.end(JSON.stringify({isError:true,content:[{type:'text',text:error.message}]}));}
    }else if(req.url==='/embedded') {res.setHeader('Content-Type','text/html');res.end(uiHtml());}
    else if(req.url==='/host.js'){res.setHeader('Content-Type','text/javascript');res.end(hostScript.outputFiles[0].contents);}
    else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body style="margin:0"><iframe title="百工面板" style="width:100%;height:1100px;border:0"></iframe><script type="module" src="/host.js"></script></body></html>');}
  });
  await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
  const page=await browser.newPage({viewport:{width:1365,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${host.address().port}`);
    const frame=page.frameLocator('iframe');
    await frame.getByRole('heading',{name:'让各有所长，协同成事。'}).waitFor();
    await frame.getByRole('switch',{name:'启用百工协作'}).click();
    await until(()=>service.store.config().settings.enabled);
    await frame.getByRole('navigation').getByRole('button',{name:/协作设置/}).click();
    await frame.getByLabel('同时执行任务数').fill('4');
    await frame.getByRole('button',{name:'保存协作设置',exact:true}).click();
    await until(()=>service.store.config().settings.concurrency===4);
    assert.deepEqual(errors,[]);
  }finally{
    await browser.close();await new Promise(resolve=>{host.close(resolve);host.closeAllConnections();});await service.close();temp.cleanup();
  }
});

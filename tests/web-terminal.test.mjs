import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const data=fs.mkdtempSync(path.join(os.tmpdir(),'yuketang-api-test-'));
fs.mkdirSync(data,{recursive:true});
fs.rmSync(data+'/config.local.json',{force:true});
const portServer=net.createServer();
await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
const port=portServer.address().port;
await new Promise(resolve=>portServer.close(resolve));
const base=`http://127.0.0.1:${port}`;
const service=spawn(process.execPath,[root+'src/server.mjs'],{env:{...process.env,UI_PORT:String(port),YUKETANG_DATA_DIR:data},stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let stream;
const controller=new AbortController();
let transcript='';
let tail='';
let closedCount=0;
async function until(fn){ const deadline=Date.now()+10000; while(Date.now()<deadline){if(await fn())return; await pause(50);} throw new Error('Test timed out: '+fn.toString()); }
const post=async(route,body,headers={})=>{
  const response=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
};
try {
  await until(async()=>{try{return(await fetch(base+'/api/status')).ok;}catch{return false;}});
  const status=await fetch(base+'/api/status');
  assert.equal(status.headers.get('x-yuketang-service-pid'),String(service.pid));
  stream=await fetch(base+'/events',{signal:controller.signal});
  const read=(async()=>{
    for await(const chunk of stream.body){
      tail+=new TextDecoder().decode(chunk);
      let boundary;
      while((boundary=tail.indexOf('\n\n'))>=0){
        const event=tail.slice(0,boundary); tail=tail.slice(boundary+2);
        const type=event.match(/event: (.+)/)?.[1];
        const json=event.match(/data: (.+)/)?.[1];
        if(!json)continue;
        const value=JSON.parse(json);
        if(type==='terminal-snapshot')transcript=value.text;
        if(type==='terminal')transcript+=value.text;
        if(type==='done')closedCount++;
      }
    }
  })().catch(()=>{});
  await until(()=>transcript.includes('服务终端已就绪'));
  assert.equal((await post('/api/terminal/run',{command:'npm run setup'})).status,200);
  await until(()=>transcript.includes('课程 URL >'));
  assert.equal((await post('/api/terminal/run',{command:'npm run doctor'})).status,409);
  await post('/api/terminal/input',{text:'not-a-url'});
  await until(()=>closedCount===1);
  assert.ok(transcript.includes('URL 格式不对'));
  await post('/api/terminal/run',{command:'npm run menu'});
  await until(()=>transcript.includes('请选择 >'));
  await post('/api/terminal/input',{text:'0'});
  await until(()=>closedCount===2);
  assert.ok(transcript.includes('再见'));
  await post('/api/terminal/run',{command:'npm run setup'});
  await post('/api/stop',{});
  await until(()=>closedCount===3);
  assert.equal((await post('/api/terminal/run',{command:'bash -c echo nope'})).status,400);
  assert.equal((await post('/api/terminal/run',{command:'npm run ui'})).status,400);
  assert.equal((await post('/api/terminal/run',{command:'npm run doctor'},{origin:'https://example.com'})).status,403);
  assert.equal((await post('/api/terminal/input',{text:'no job'})).status,409);
  await post('/api/llm',{baseUrl:'http://127.0.0.1:11434/v1',model:'fixture-model',apiKey:'fixture-not-secret'});
  await post('/api/llm',{baseUrl:'http://127.0.0.1:11434/v1',model:'changed-model',apiKey:''});
  assert.equal(JSON.parse(fs.readFileSync(data+'/config.local.json')).llm.apiKey,'fixture-not-secret');
  assert.equal((await post('/api/switch',{classroomId:12345})).status,400);
  assert.deepEqual((await(await fetch(base+'/api/status')).json()).running,null);
  console.log('PASS: real command input/output, concurrency lock, menu exit, stop, origin checks, scope limits, preserve blank AI key, reject invalid course, service PID header');
  controller.abort(); await read;
} finally {
  controller.abort();
  if (service.exitCode === null) {
    service.kill('SIGTERM');
    await new Promise(resolve=>service.once('exit',resolve));
  }
  // Windows 没有真正的 SIGTERM：child.kill 会直接 TerminateProcess，
  // 子进程 exitCode 是 1（或被信号杀死时为 null）。
  // macOS / Linux 上服务能捕获 SIGTERM 并 process.exit(0)，所以仍严格断言。
  if (process.platform === 'win32') {
    assert.ok(
      service.exitCode === 0 || service.exitCode === 1 || service.exitCode === null,
      `unexpected exitCode on win32: ${service.exitCode}`,
    );
  } else {
    assert.equal(service.exitCode,0);
  }
  fs.rmSync(data,{recursive:true,force:true});
}

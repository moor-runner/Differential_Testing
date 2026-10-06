import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root } from './common.mjs';

const runTag = new Date().toISOString().replace(/[:.]/g, '-');
const dataDir = path.join(root, 'tmp', 'acceptance', runTag);
await mkdir(dataDir, { recursive: true });
const token = randomBytes(32).toString('hex');
const results = [];
let child, origin, logs = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boot() {
  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java';
  child = spawn(java, ['-Xmx512m', '-Dfile.encoding=UTF-8', '-jar', path.join(root, 'backend', 'target', 'duipai-backend.jar'), '--server.port=0'], {
    cwd: root, windowsHide: true, env: { ...process.env, DUIPAI_TOKEN: token, DUIPAI_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe']
  });
  logs = '';
  child.stderr.on('data', data => { logs += data; });
  child.stdout.on('data', data => { logs += data; });
  for (let i = 0; i < 450; i++) {
    const match = logs.match(/DUIPAI_READY:(\d+)/);
    if (match) { origin = `http://127.0.0.1:${match[1]}`; return; }
    if (child.exitCode !== null) throw new Error(`Backend exited ${child.exitCode}: ${logs}`);
    await pause(100);
  }
  throw new Error(`Startup timeout: ${logs}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  try { await request('/api/shutdown', 'POST'); } catch {}
  for (let i = 0; i < 100 && child.exitCode === null; i++) await pause(100);
  if (child.exitCode === null) { child.kill(); throw new Error('Backend did not shut down gracefully'); }
}
async function request(url, method = 'GET', body) {
  const response = await fetch(origin + url, { method, headers: { 'X-Duipai-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
async function test(name, callback) {
  const started = Date.now();
  await callback();
  results.push({ name, status: 'PASS', elapsedMs: Date.now() - started });
  console.log(`PASS ${name}`);
}
const generator = `public class Main { public static void main(String[] args) { long seed=Long.parseLong(args[0]); int n=(int)Math.floorMod(seed,5L)+1; System.out.println(n); } }`;
const brute = `import java.util.*; public class Main { public static void main(String[] args) { int n=new Scanner(System.in).nextInt(); long s=0; for(int i=1;i<=n;i++)s+=i; System.out.println(s); } }`;
const correct = `import java.util.*; public class Main { public static void main(String[] args) { int n=new Scanner(System.in).nextInt(); System.out.println((long)n*(n+1)/2); } }`;
const wrong = `import java.util.*; public class Main { public static void main(String[] args) { int n=new Scanner(System.in).nextInt(); System.out.println(n>=3 ? 0 : (long)n*(n+1)/2); } }`;
let problem, failing;
async function save(optimized, overrides = {}, otherCodes = {}) {
  problem = await request(`/api/problems/${problem.id}`, 'PUT', { ...problem, codes: { generator, brute, optimized, ...otherCodes }, settings: { rounds: 1000, startSeed: '0', parallelism: 1, generatorTimeoutMs: 5000, bruteTimeoutMs: 10000, optimizedTimeoutMs: 2000, ...overrides } });
}
async function job(replaySeed) {
  const started = await request('/api/jobs', 'POST', { problemId: problem.id, ...(replaySeed !== undefined ? { replaySeed } : {}) });
  for (let i = 0; i < 900; i++) {
    const snapshot = await request(`/api/jobs/${started.id}`);
    if (snapshot.state === 'FINISHED') return snapshot;
    await pause(100);
  }
  throw new Error(`Job timed out ${started.id}`);
}

try {
  await boot();
  await test('本机令牌鉴权及跨域来源校验', async () => {
    assert.equal((await fetch(origin + '/api/health')).status, 401);
    assert.equal((await fetch(origin + '/api/health', { headers: { 'X-Duipai-Token': token, Origin: 'https://untrusted.example' } })).status, 403);
    assert.match(String((await request('/api/health')).javaVersion), /^21/);
  });
  await test('题目新建 / 图片保存 / 公式题面 / 布局持久化', async () => {
    problem = await request('/api/problems', 'POST', { title: '验收：n ≥ 3 才出错' });
    assert.ok(problem.codes.generator.includes('args[0]'));
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1cAAAAASUVORK5CYII=', 'base64');
    const form = new FormData(); form.append('file', new Blob([image], { type: 'image/png' }), 'screenshot.png');
    const uploaded = await fetch(origin + '/api/images', { method: 'POST', headers: { 'X-Duipai-Token': token }, body: form });
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    const { url } = await uploaded.json();
    assert.equal((await fetch(origin + url, { headers: { 'X-Duipai-Token': token } })).status, 200);
    problem.statement = `# 求和\n计算 $\\sum_{i=1}^n i$。\n![截图](${url})`;
    await save(wrong);
    await request('/api/settings/layout', 'PUT', { outer: 16, statement: 29, editors: [33, 34, 33], results: 40 });
    assert.equal((await request('/api/settings/layout')).outer, 16);
  });
  await test('1000 轮内捕获 WA、种子、输入与首个差异', async () => {
    failing = await job();
    assert.equal(failing.verdict, 'WA'); assert.equal(failing.seed, '2'); assert.equal(failing.round, 3);
    assert.equal(failing.input.trim(), '3'); assert.equal(failing.brute.stdout.trim(), '6'); assert.equal(failing.optimized.stdout.trim(), '0');
    assert.equal(failing.firstDifference.line, 1);
  });
  await test('按种子复现与修复后单轮完整展示', async () => {
    const replay = await job(failing.seed);
    assert.equal(replay.input, failing.input); assert.equal(replay.brute.stdout, failing.brute.stdout); assert.equal(replay.optimized.stdout, failing.optimized.stdout);
    await save(correct);
    const fixed = await job(failing.seed);
    assert.equal(fixed.verdict, 'PASS'); assert.equal(fixed.input, failing.input); assert.equal(fixed.optimized.stdout, fixed.brute.stdout);
    const old = await request(`/api/runs/${failing.id}`);
    assert.equal(old.codes.optimized, wrong);
  });
  await test('只忽略行尾空白、末尾空行及 CRLF', async () => {
    const whitespace = `import java.util.*; public class Main { public static void main(String[] args) { int n=new Scanner(System.in).nextInt(); System.out.print(((long)n*(n+1)/2)+"  \\r\\n\\r\\n"); } }`;
    await save(whitespace);
    assert.equal((await job('2')).verdict, 'PASS');
  });
  await test('编译失败不执行且返回编译诊断', async () => {
    await save(correct, {}, { brute: 'public class Main { public static void main(String[] args) { missing; } }' });
    const result = await job();
    assert.equal(result.verdict, 'CE'); assert.equal(result.completed, 0);
    assert.ok(result.compileErrors.some(item => item.role === 'brute' && item.diagnostics.length));
  });
  await test('优化解死循环 TLE', async () => {
    await save('public class Main { public static void main(String[] args) { while(true){} } }', { optimizedTimeoutMs: 300 });
    const result = await job('2'); assert.equal(result.verdict, 'TLE'); assert.equal(result.optimized.timedOut, true);
  });
  await test('优化解异常 RE 与 Java 异常栈', async () => {
    await save('public class Main { public static void main(String[] args) { throw new IllegalStateException("acceptance-boom"); } }');
    const result = await job('2'); assert.equal(result.verdict, 'RE'); assert.match(result.optimized.stderr, /acceptance-boom/); assert.match(result.optimized.stderr, /Main.main/);
  });
  await test('疯狂输出 OLE 与有界输出', async () => {
    await save('public class Main { public static void main(String[] args) throws Exception { byte[] b=new byte[16384]; java.util.Arrays.fill(b,(byte)65); while(true){System.out.write(b);} } }');
    const result = await job('2'); assert.equal(result.verdict, 'OLE'); assert.equal(result.optimized.outputLimited, true);
    assert.ok(Buffer.byteLength(result.optimized.stdout) <= 8 * 1024 * 1024);
  });
  await test('裁判或数据出错单独判定', async () => {
    const crash = 'public class Main { public static void main(String[] args) { throw new IllegalArgumentException("judge-broken"); } }';
    await save(correct, {}, { generator: crash });
    assert.equal((await job('2')).verdict, 'GENERATOR_ERROR');
    await save(correct, {}, { brute: crash });
    assert.equal((await job('2')).verdict, 'BRUTE_ERROR');
  });
  await test('唯一任务、手动停止与停止后健康', async () => {
    await save('public class Main { public static void main(String[] args) throws Exception { Thread.sleep(15000); } }', { optimizedTimeoutMs: 20000, parallelism: 4 });
    const started = await request('/api/jobs', 'POST', { problemId: problem.id });
    const conflict = await fetch(origin + '/api/jobs', { method: 'POST', headers: { 'X-Duipai-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ problemId: problem.id }) });
    assert.equal(conflict.status, 409);
    await pause(1000); await request(`/api/jobs/${started.id}/cancel`, 'POST');
    for (let i = 0; i < 100; i++) {
      const state = await request(`/api/jobs/${started.id}`);
      if (state.state === 'FINISHED') { assert.equal(state.verdict, 'CANCELLED'); break; }
      if (i === 99) assert.fail('Cancellation timeout');
      await pause(100);
    }
    assert.equal((await request('/api/health')).status, 'ok');
  });
  await test('超过 1MB 原始内容可导出', async () => {
    const large = 'public class Main { public static void main(String[] args) { System.out.print("A".repeat(1100000)); } }';
    await save(large, {}, { brute: large });
    const result = await job('2'); assert.equal(result.verdict, 'PASS');
    const exported = await fetch(origin + `/api/runs/${result.id}/export/optimized`, { headers: { 'X-Duipai-Token': token } });
    assert.equal(exported.status, 200); assert.equal((await exported.text()).length, 1100000);
  });
  await test('重启后题面图片 / 代码 / 参数 / 布局 / 历史不丢', async () => {
    await stop(); await boot();
    const persisted = await request(`/api/problems/${problem.id}`);
    assert.equal(persisted.statement, problem.statement); assert.deepEqual(persisted.codes, problem.codes); assert.deepEqual(persisted.settings, problem.settings);
    assert.equal((await request('/api/settings/layout')).outer, 16);
    const imageUrl = persisted.statement.match(/!\[截图\]\(([^)]+)\)/)[1];
    assert.equal((await fetch(origin + imageUrl, { headers: { 'X-Duipai-Token': token } })).status, 200);
    const history = await request(`/api/problems/${problem.id}/runs`); assert.ok(history.length >= 10);
    assert.equal((await request(`/api/runs/${failing.id}`)).verdict, 'WA');
  });
  await test('改名 / 删除与后端随关闭退出', async () => {
    const disposable = await request('/api/problems', 'POST', { title: '删除验收' });
    const renamed = await request(`/api/problems/${disposable.id}`, 'PUT', { ...disposable, title: '改名验收' }); assert.equal(renamed.title, '改名验收');
    await request(`/api/problems/${disposable.id}`, 'DELETE');
    assert.equal((await fetch(origin + `/api/problems/${disposable.id}`, { headers: { 'X-Duipai-Token': token } })).status, 404);
    await stop(); assert.notEqual(child.exitCode, null);
  });
  await writeFile(path.join(root, 'docs', 'acceptance-results.json'), JSON.stringify({ date: new Date().toISOString(), dataDir, results }, null, 2));
  console.log(`\n${results.length} 项真实后端验收通过。`);
} finally {
  await writeFile(path.join(dataDir, 'backend-test.log'), logs).catch(() => {});
  await stop();
}

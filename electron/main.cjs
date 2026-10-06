const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, screen } = require('electron');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepareBackendRuntime } = require('./backend-runtime.cjs');

let window, backend, backendUrl, dataDir, javaVersion;
let closing = false, closePending = false, shutdownStarted = false, startupComplete = false;
const root = path.resolve(__dirname, '..');
if (process.env.DUIPAI_USER_DATA_DIR || !app.isPackaged) {
  app.setPath('userData', path.resolve(process.env.DUIPAI_USER_DATA_DIR || path.join(root, '.cache', 'electron-profile')));
}
const token = randomBytes(32).toString('hex');
const devUrl = process.env.DUIPAI_DEV_URL;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findJdk() {
  const candidates = [process.env.DUIPAI_JAVA_HOME, process.env.JAVA_HOME].filter(Boolean);
  for (const home of candidates) {
    const java = path.join(home, 'bin', 'java.exe');
    const javac = path.join(home, 'bin', 'javac.exe');
    if (fs.existsSync(java) && fs.existsSync(javac)) return validate(java);
  }
  try {
    const java = execFileSync('where.exe', ['java'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    if (fs.existsSync(path.join(path.dirname(java), 'javac.exe'))) return validate(java);
  } catch {}
  throw new Error('未找到 JDK 21。请安装 JDK 21 并将其 bin 目录加入 PATH，或设置 JAVA_HOME。');
}

function validate(java) {
  const info = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (info.error) throw info.error;
  if (info.status !== 0 || !/version\s+"21(?:\.|\")/.test(info.stderr + info.stdout)) {
    throw new Error('后端和用户程序需要共用 JDK 21，请检查 JAVA_HOME 或 DUIPAI_JAVA_HOME。');
  }
  return java;
}

async function startBackend() {
  const java = findJdk();
  dataDir = path.resolve(process.env.DUIPAI_DATA_DIR || (app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(root, 'data')));
  fs.mkdirSync(dataDir, { recursive: true });
  const sourceJar = app.isPackaged ? path.join(process.resourcesPath, 'backend', 'duipai-backend.jar') : path.join(root, '.cache', 'backend-build', 'duipai-backend.jar');
  if (!fs.existsSync(sourceJar)) throw new Error('后端尚未构建，请先运行 npm run build。');
  const runtime = prepareBackendRuntime(sourceJar, app.getPath('userData'));
  const log = fs.createWriteStream(path.join(dataDir, 'backend.log'), { flags: 'a' });
  backend = spawn(java, ['-Xms64m', '-Xmx512m', '-Dfile.encoding=UTF-8', '-jar', runtime.jar, '--server.port=0', `--duipai.parent-pid=${process.pid}`], {
    cwd: dataDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DUIPAI_TOKEN: token, DUIPAI_DATA_DIR: dataDir, ...(devUrl ? { DUIPAI_DEV_ORIGIN: devUrl } : {}) }
  });
  backend.once('exit', () => runtime.cleanup());
  backend.once('error', () => runtime.cleanup());
  backend.stderr.pipe(log, { end: false });
  backend.stdout.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`后端启动超时。详细日志：${path.join(dataDir, 'backend.log')}`)), 45000);
    backend.stdout.on('data', chunk => {
      output = (output + chunk.toString('utf8')).slice(-16000);
      const match = output.match(/DUIPAI_READY:(\d+)/);
      if (match) { backendUrl = `http://127.0.0.1:${match[1]}`; clearTimeout(timer); resolve(); }
    });
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', code => { clearTimeout(timer); reject(new Error(`后端退出，代码 ${code}。详细日志：${path.join(dataDir, 'backend.log')}`)); });
  });
  const health = await fetch(`${backendUrl}/api/health`, { headers: { 'X-Duipai-Token': token } });
  if (!health.ok) throw new Error(`后端健康检查失败：${health.status}`);
  javaVersion = (await health.json()).javaVersion;
  if (!String(javaVersion).startsWith('21')) throw new Error(`当前 Java 版本 ${javaVersion}，请使用 JDK 21。`);
  backend.once('exit', () => {
    log.end();
    if (startupComplete && !shutdownStarted) {
      dialog.showErrorBox('后端意外退出', `请查看 ${path.join(dataDir, 'backend.log')} 后重新启动。`);
      app.quit();
    }
  });
}

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (!backend || backend.exitCode !== null) return;
  try {
    await fetch(`${backendUrl}/api/shutdown`, { method: 'POST', headers: { 'X-Duipai-Token': token }, signal: AbortSignal.timeout(3000) });
  } catch {}
  for (let i = 0; i < 50 && backend.exitCode === null; i++) await sleep(100);
  if (backend.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}

function isTrusted(event) {
  try { return event.sender === window?.webContents && new URL(event.senderFrame.url).origin === new URL(devUrl || backendUrl).origin; } catch { return false; }
}

async function flushRenderer() {
  if (!window || window.isDestroyed() || !startupComplete) return;
  const id = randomBytes(8).toString('hex');
  await new Promise((resolve, reject) => {
    const listener = (event, value) => {
      if (!isTrusted(event) || value?.id !== id) return;
      clearTimeout(timer); ipcMain.removeListener('duipai:close-ready', listener);
      value.error ? reject(new Error(value.error)) : resolve();
    };
    const timer = setTimeout(() => { ipcMain.removeListener('duipai:close-ready', listener); reject(new Error('保存尚未完成，窗口已保留。请等待保存完成后再关闭。')); }, 5000);
    ipcMain.on('duipai:close-ready', listener);
    window.webContents.send('duipai:before-close', id);
  });
}

async function openWindow() {
  const origin = devUrl || backendUrl;
  await session.defaultSession.cookies.set({ url: backendUrl, name: 'duipai_token', value: token, httpOnly: true, sameSite: 'strict', path: '/' });
  // In dev the session cookie applies to 127.0.0.1 at both ports; it never exposes the token to page JavaScript.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const bounds = screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({
    width: Math.min(1600, bounds.width), height: Math.min(980, bounds.height), minWidth: 1100, minHeight: 700,
    title: '对拍工作台', backgroundColor: '#11151c', show: false, autoHideMenuBar: true,
    icon: path.join(root, 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: process.env.DUIPAI_TEST_HIDDEN !== '1' }
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== new URL(origin).origin) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { if (process.env.DUIPAI_TEST_HIDDEN !== '1') window.show(); });
  window.on('close', async event => {
    if (closing) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    window.setEnabled(false);
    try { await flushRenderer(); }
    catch (error) { closePending = false; window.setEnabled(true); dialog.showErrorBox('保存失败，窗口已保留', String(error.message)); return; }
    closing = true;
    await shutdown();
    window.destroy(); app.quit();
  });
  await window.loadURL(origin);
  startupComplete = true;
}

ipcMain.handle('duipai:info', event => {
  if (!isTrusted(event)) throw new Error('拒绝非工作台调用');
  return { version: app.getVersion(), dataDir, javaVersion, backendPid: backend?.pid };
});
ipcMain.handle('duipai:open-data', async event => {
  if (!isTrusted(event)) throw new Error('拒绝非工作台调用');
  const error = await shell.openPath(dataDir);
  if (error) throw new Error(error);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    try { await startBackend(); await openWindow(); }
    catch (error) { dialog.showErrorBox('无法启动对拍工作台', String(error.message)); await shutdown(); closing = true; app.quit(); }
  });
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault();
    if (window && !window.isDestroyed()) window.close();
    else shutdown().then(() => { closing = true; app.quit(); });
  });
  app.on('window-all-closed', () => app.quit());
}

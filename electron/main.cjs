/**
 * main.cjs — Electron 主进程
 *
 * 说明：PDScope 的解析与界面完全跑在渲染进程里（纯前端），
 *      所以主进程只做三件事：
 *        1. 开一个无边框感的原生窗口（隐藏菜单栏、跟随主题背景）
 *        2. 挂一份中文原生菜单，把「打开抓包」接到页面的文件选择上
 *        3. 优先加载打包好的单文件 dist/PDScope.html；没有就临时起本地服务再加载
 *
 * 这样同一套渲染代码在浏览器 / Electron 里表现一致。
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const STANDALONE = path.join(ROOT, 'dist', 'PDScope.html');
const UI_DIR = path.join(ROOT, 'src', 'ui');
const SRC_DIR = path.join(ROOT, 'src');

let win = null;
let localServer = null;
let localPort = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

/** 兜底：没打包成单文件时，起一个极小静态服务，避免 file:// 下 ES Module 被 CORS 拦 */
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (p === '/') p = '/index.html';
      let file;
      if (p.startsWith('/js/')) file = path.join(SRC_DIR, p);
      else if (p.startsWith('/ui/')) file = path.join(SRC_DIR, p.slice(1));
      else file = path.join(UI_DIR, p);
      const norm = path.resolve(file);
      if (!norm.startsWith(path.resolve(ROOT))) { res.writeHead(403).end(); return; }
      fs.readFile(norm, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(norm).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { localServer = srv; localPort = srv.address().port; resolve(localPort); });
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#eef1f5',
    title: 'PDScope · USB PD 抓包解析',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (fs.existsSync(STANDALONE)) {
    await win.loadFile(STANDALONE);
  } else {
    const port = await startStaticServer();
    await win.loadURL(`http://127.0.0.1:${port}/`);
  }

  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

/** 让渲染进程里的文件选择被点一下 */
function triggerOpen() {
  win?.webContents.executeJavaScript("document.querySelector('#fileInput')?.click();").catch(() => {});
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开抓包…', accelerator: 'CmdOrCtrl+O', click: triggerOpen },
        { label: '关闭抓包', accelerator: 'CmdOrCtrl+W', click: () => win?.webContents.executeJavaScript('location.reload()') },
        { type: 'separator' },
        {
          label: '另存为 CSV（当前筛选）',
          accelerator: 'CmdOrCtrl+S',
          click: () => { shell.openExternal('data:,'); win?.webContents.executeJavaScript("document.querySelector('#btnExport')?.click()"); },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '搜索报文', accelerator: 'CmdOrCtrl+F', click: () => win?.webContents.executeJavaScript("document.querySelector('#fSearch')?.focus()") },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换主题', accelerator: 'CmdOrCtrl+T', click: () => win?.webContents.executeJavaScript("document.querySelector('#btnTheme')?.click()") },
        { label: '折叠/展开筛选栏', accelerator: 'CmdOrCtrl+B', click: () => win?.webContents.executeJavaScript("document.querySelector('#btnToggleSide')?.click()") },
        { label: '紧凑/舒适行高', click: () => win?.webContents.executeJavaScript("document.querySelector('#btnDense')?.click()") },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 PDScope',
          click: () => dialog.showMessageBox(win, {
            type: 'info', title: '关于 PDScope', message: 'PDScope',
            detail: `USB Power Delivery 抓包解析上位机\n\n直接解析正点原子 ATK-C 的 .atkcc 抓包文件：\n`
              + `· 1 bit/采样 LSB 优先 → BMC → 4B5B → PD 报文\n`
              + `· Source / Sink / 线缆方向自动区分\n`
              + `· 按方向 / SOP / 报文类型 / 时间窗口筛选屏蔽\n`
              + `· Source_Cap、Request、PPS、AVS、VDM、扩展报文逐字段溯源\n\n`
              + `版本 ${app.getVersion()} · Electron ${process.versions.electron} · Node ${process.versions.node}`,
            buttons: ['好'], noLink: true,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  localServer?.close();
  if (process.platform !== 'darwin') app.quit();
});

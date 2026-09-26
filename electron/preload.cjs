/**
 * preload.cjs — 只往渲染进程暴露一点点「我是桌面版」的信息。
 *
 * 页面本身是纯前端（文件读取走 <input type="file"> / 拖拽），
 * 因此这里不需要暴露任何 Node 能力，保持最小攻击面。
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('pdscopeHost', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

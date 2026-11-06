// 把输入发给页面里的浮动面板，并做一次自检。
const BUILD = 'v1.0.0';
const $ = (id) => document.getElementById(id);

function show(kind, msg) {
  const el = $('status');
  el.className = 'status ' + kind;
  el.textContent = msg;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

// 页面里的面板会响应 ping，用来确认「加载的到底是哪个版本」
async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch (e) {
    return null;
  }
}

async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

$('startBtn').addEventListener('click', async () => {
  const raw = $('accounts').value.trim();
  const drama = $('drama').value.trim();
  const library = $('library').value.trim();
  const materialFolder = $('materialFolder').value.trim();
  const copy = $('copyTemplate').checked;

  if (!raw) return show('error', '请先填账户 ID');
  if (!drama) return show('error', '请先填短剧名');
  if (!library) return show('error', '请先填商品库名称');
  if (!materialFolder) return show('error', '请先填素材目录名称');

  const accounts = [...new Set(raw.split(/[\s,，;；\n]+/).map((s) => s.trim()).filter(Boolean))];
  if (!accounts.length) return show('error', '账户 ID 无效');

  const tab = await activeTab();
  if (!tab || !tab.url || tab.url.indexOf('mobgi.com') < 0) {
    return show('error', '请先切到创量的投放页面，再点开始');
  }

  // 账户、短剧、商品库和素材目录只在当前操作中使用，不持久化。
  chrome.storage.local.set({ lastCopy: copy });

  let pong = await ping(tab.id);
  if (!pong) {
    await ensureInjected(tab.id);
    pong = await ping(tab.id);
  }
  if (!pong) {
    return show('error', '页面里没有脚本在跑。请按 Ctrl+F5 刷新创量页面后重试；如果还不行，去 edge://extensions 点一下本扩展的「⟳ 刷新」');
  }

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      action: 'start',
      payload: { accounts, drama, copyTemplate: copy, library, materialFolder }
    });
    if (resp && resp.ok) {
      show('ok', '✅ 已开始（页面版本 ' + (resp.build || pong.build || '?') + '），切到创量页面看右下角面板');
      setTimeout(() => window.close(), 900);
    } else {
      show('error', (resp && resp.error) || '启动失败');
    }
  } catch (e) {
    show('error', '发送失败：' + e.message);
  }
});

// 自检按钮：显示页面上实际在跑的脚本版本
$('checkBtn').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || !tab.url || tab.url.indexOf('mobgi.com') < 0) {
    return show('error', '当前标签页不是 mobgi.com');
  }
  let pong = await ping(tab.id);
  if (!pong) {
    await ensureInjected(tab.id);
    pong = await ping(tab.id);
  }
  if (!pong) return show('error', '页面里没有脚本 → 需要 Ctrl+F5 刷新创量页面');
  show('ok', '页面在跑：' + pong.build + (pong.running ? '（执行中）' : '（空闲）'));
});

chrome.storage.local.get(['lastCopy'], (v) => {
  if (v.lastCopy !== undefined) $('copyTemplate').checked = v.lastCopy;
});

$('ver').textContent = BUILD;


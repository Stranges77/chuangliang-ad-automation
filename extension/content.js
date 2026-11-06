/* =========================================================
 * 创量批量投放助手 - content.js
 * 项目版本以 extension/manifest.json 为准。
 * 支持统一模式、多账户（各自一剧）和可选售卖策略。
 * ========================================================= */

(function () {
  'use strict';

  if (window.__MB_ASSISTANT_V5__) return;
  window.__MB_ASSISTANT_V5__ = true;
  if (window.top !== window.self) return;

  var BUILD = 'v1.0.0 · 2026-11-06 · 首个规范化发布基线（支持统一模式与多账户分剧）';
  // 面板标题只显示「版本 · 日期」，完整说明放在 title 里，避免把右侧按钮挤出去
  var BUILD_SHORT = BUILD.split(' · ').slice(0, 2).join(' · ');

  /** 商品库和素材目录由用户在运行前填写，不在源码中保存个人或公司数据。 */

  var STATE = {
    running: false, paused: false, stopped: false,
    stepIndex: 0, failedStep: -1, logs: [],
    strategy: null, queue: null, queueIndex: 0, opts: {}
  };

  /**
   * 可中断的等待：点「停止」时会把所有正在等待的 sleep 立刻 reject，
   * 让整条流程马上中断，而不是等当前这一步（或某个 40 秒的等待）跑完
   */
  var PENDING_SLEEPS = [];

  /**
   * 可中断 + 可暂停的等待：
   *   - 点「停止」立刻 reject，整条流程马上中断
   *   - 点「暂停」时不再消耗剩余时间，最多 200ms 就停住，点「继续」再往下走
   *   - ignorePause = true 时忽略暂停（waitFor 用，避免暂停自己把自己锁死）
   */
  function sleep(ms, ignorePause) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var remain = ms;
      var entry = {
        cancel: function () {
          if (done) return;
          done = true;
          reject(new Error('__MB_STOPPED__'));
        }
      };
      PENDING_SLEEPS.push(entry);

      var finish = function () {
        if (done) return;
        done = true;
        var k = PENDING_SLEEPS.indexOf(entry);
        if (k >= 0) PENDING_SLEEPS.splice(k, 1);
        resolve();
      };

      var tick = function () {
        if (done) return;
        if (STATE.stopped) { entry.cancel(); return; }
        if (STATE.paused && !ignorePause) { setTimeout(tick, 200); return; }
        var step = Math.min(remain, 250);
        remain -= step;
        setTimeout(function () {
          if (done) return;
          if (remain > 0) tick(); else finish();
        }, step);
      };
      tick();
    });
  }

  /** 停止时把所有挂起的等待一起打断 */
  function cancelAllSleeps() {
    var list = PENDING_SLEEPS.slice();
    PENDING_SLEEPS = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].cancel(); } catch (e) {}
    }
  }

  function log(msg, type) {
    type = type || 'info';
    var t = new Date().toLocaleTimeString();
    STATE.logs.push({ t: t, msg: msg, type: type });
    if (STATE.logs.length > 240) STATE.logs = STATE.logs.slice(-240);
    var el = document.getElementById('mb5-logs');
    if (el) {
      var line = document.createElement('div');
      line.style.cssText = 'padding:1px 0;font-size:11px;color:' +
        (type === 'err' ? '#E5484D' : type === 'ok' ? '#2A9D8F' : '#4B5563');
      line.textContent = '[' + t + '] ' + msg;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    }
    try { console.log('[MB5] ' + msg); } catch (e) {}
  }

  /* -------------------- DOM 工具 -------------------- */

  /**
   * 元素是否真的对用户可见
   * 关键：这个页面 DOM 里有 60+ 个 .el-dialog（大量是关掉后残留的），
   * 光看 offsetParent / 尺寸会把 visibility:hidden、opacity:0 的旧弹窗算成"可见"
   */
  function visible(el) {
    if (!el) return false;
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.offsetParent === null && cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    return true;
  }

  function isHidden(el) {
    var cls = String((el && el.className) || '');
    return cls.indexOf('hidden') >= 0 || cls.indexOf('__close') >= 0;
  }

  /** 找当前真正可见的弹窗（带 overlay 也算） */
  function getVisibleDialog() {
    var sel = [
      '.el-dialog', '.el-message-box', '.el-drawer',
      '.ant-modal', '.ant-drawer',
      '.gdt-account-select-dialog',
      '[role="dialog"]',
      '.cl-drawer'
    ];
    for (var s = 0; s < sel.length; s++) {
      var list = document.querySelectorAll(sel[s]);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!visible(el)) continue;
        if (isHidden(el)) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 60) continue;
        return el;
      }
    }
    return null;
  }

  /**
   * 只找「选择媒体账户」那一个弹窗（不认其它弹窗）
   * 用于 Step 5 判断账户弹窗到底关没关 —— 不能用 getVisibleDialog，
   * 否则页面上任何残留弹窗都会让它误判"还没关"
   */
  function getAccountDialog() {
    var list = document.querySelectorAll('.gdt-account-select-dialog');
    for (var i = 0; i < list.length; i++) {
      if (visible(list[i])) return list[i];
    }
    var dlgs = document.querySelectorAll('.el-dialog, .el-drawer, [role="dialog"]');
    for (var j = 0; j < dlgs.length; j++) {
      var el = dlgs[j];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      var head = el.querySelector('.el-dialog__title, .el-dialog__header');
      var ht = head ? (head.textContent || '') : '';
      if (ht.indexOf('选择媒体账户') >= 0) return el;
      // 有搜索框 placeholder 含"关键词" + 表格，也认作账户弹窗
      var hasKwSearch = false;
      var ins = el.querySelectorAll('input');
      for (var k = 0; k < ins.length; k++) {
        if ((ins[k].placeholder || '').indexOf('关键词') >= 0) { hasKwSearch = true; break; }
      }
      if (hasKwSearch && el.querySelector('tbody tr')) return el;
    }
    return null;
  }

  /** 轮询等待条件成立（ms） */
  async function waitFor(fn, timeout, interval) {
    interval = interval || 300;
    var t = 0;
    while (t < timeout) {
      try { if (fn()) return true; } catch (e) {}
      await sleep(interval, true);   // 轮询不受「暂停」影响，否则手动接管时会锁死
      t += interval;
    }
    try { return !!fn(); } catch (e) { return false; }
  }

  /** 在指定弹窗里按文字优先级找按钮（右下角优先） */
  function findDialogButton(dlg, labels) {
    if (!dlg) return null;
    var best = null, bestScore = -1e9;
    var list = dlg.querySelectorAll('button, .el-button, [role="button"]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!visible(b) || isDisabled(b)) continue;
      var t = (b.textContent || '').replace(/\s+/g, '').trim();
      if (!t) continue;
      var rank = -1;
      for (var L = 0; L < labels.length; L++) {
        if (t === labels[L]) { rank = labels.length - L; break; }
      }
      if (rank < 0) continue;
      var r = b.getBoundingClientRect();
      if (r.width < 16 || r.height < 14) continue;
      var score = rank * 10000 + r.top + r.right;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  /** 在容器里按文字找最小可点元素（兼容 radio-button / label / span） */
  function findTextEl(root, text) {
    if (!root) return null;
    var list = root.querySelectorAll('.el-radio-button, .el-radio-button__inner, label, span, button, a, div');
    var best = null, bestArea = 1e18;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (t !== text) continue;
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (area > 0 && area < bestArea) { bestArea = area; best = el; }
    }
    return best;
  }

  /** 兼容旧调用 */
  function findDialogConfirm(dlg) {
    return findDialogButton(dlg, ['确定', '确认']);
  }

  /**
   * 处理「复用配置」弹窗
   * 这个弹窗的按钮是「重新配置 / 复用」——注意「复用」才是确认应用模板
   * 返回 true 表示处理过
   */
  async function confirmReuseDialog() {
    var d = null;
    for (var i = 0; i < 14; i++) {
      var dd = getVisibleDialog();
      if (dd) {
        var txt = (dd.textContent || '').replace(/\s+/g, '');
        if (txt.indexOf('复用配置') >= 0 || txt.indexOf('是否复用当前配置') >= 0) { d = dd; break; }
      }
      await sleep(250);
    }
    if (!d) return false;

    var labels = ['复用', '确认', '确定', '是'];
    var btn = findDialogButton(d, labels);
    if (!btn) {
      log('  ⚠ 复用弹窗里没找到可点的确认按钮，弹窗按钮：' +
          collectDialogButtons(d), 'err');
      return false;
    }
    log('  · 复用弹窗按钮：' + collectDialogButtons(d) + ' → 点「' + (btn.textContent || '').replace(/\s+/g, '') + '」');
    forceClickOne(btn);

    // 等这个弹窗消失
    await waitFor(function () {
      var x = getVisibleDialog();
      if (!x) return true;
      var t = (x.textContent || '').replace(/\s+/g, '');
      return t.indexOf('复用配置') < 0 && t.indexOf('是否复用当前配置') < 0;
    }, 5000, 250);
    return true;
  }

  function collectDialogButtons(dlg) {
    var out = [];
    var list = dlg.querySelectorAll('button, .el-button, [role="button"]');
    for (var i = 0; i < list.length; i++) {
      if (!visible(list[i])) continue;
      var t = (list[i].textContent || '').replace(/\s+/g, '');
      if (t) out.push(t);
    }
    return out.join('/');
  }

  /** 创量自定义弹窗：右侧「广告基本信息」抽屉 */
  function getInfoDrawer() {
    var list = document.querySelectorAll('.cl-drawer');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.indexOf('广告基本信息') >= 0 || t.indexOf('投放方式') >= 0) return el;
    }
    return null;
  }

  /** 「创意素材」抽屉（手动选取素材 / 动态选取素材） */
  function getCreativeDrawer() {
    var list = document.querySelectorAll('.cl-drawer');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.indexOf('手动选取素材') >= 0 || t.indexOf('创意组数量') >= 0) return el;
    }
    return null;
  }

  /** 素材库弹窗（.material-selector-dialog） */
  function getMaterialDialog() {
    var list = document.querySelectorAll('.el-dialog, .cl-dialog, [role="dialog"]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 200) continue;
      var cls = String(el.className || '');
      if (cls.indexOf('material-selector') >= 0) return el;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.indexOf('素材库') >= 0 && t.indexOf('提交') >= 0) return el;
    }
    return null;
  }

  /** 在指定容器里，按「标签文字」找到它右边最近的可编辑输入框 */
  function findInputNearLabel(root, labelText) {
    root = root || document;
    var anchor = null;
    var list = root.querySelectorAll('label, span, div');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (t !== labelText) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 160 || r.height > 32) continue;
      anchor = r; break;
    }
    if (!anchor) return null;

    var inputs = root.querySelectorAll('input');
    var best = null, bestD = 1e9;
    for (var j = 0; j < inputs.length; j++) {
      var inp = inputs[j];
      if (!visible(inp)) continue;
      if (inp.type === 'checkbox' || inp.type === 'radio') continue;
      var ir = inp.getBoundingClientRect();
      var dy = Math.abs((ir.top + ir.height / 2) - (anchor.top + anchor.height / 2));
      var dx = ir.left - anchor.left;
      if (dy > 34 || dx < -60) continue;
      if (dx < bestD) { bestD = dx; best = inp; }
    }
    return best;
  }

  /** 在可见的 el-select 下拉里，按文字找选项 */
  function findVisibleOption(text) {
    var boxes = document.querySelectorAll('.el-select-dropdown');
    for (var b = 0; b < boxes.length; b++) {
      var box = boxes[b];
      var cs;
      try { cs = getComputedStyle(box); } catch (e) { continue; }
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var lis = box.querySelectorAll('li');
      for (var i = 0; i < lis.length; i++) {
        var t = (lis[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.indexOf(text) >= 0) return lis[i];
      }
    }
    return null;
  }

  /** 从「剧名 商品ID」里取出剧名（去掉尾部长数字 ID 再归一化） */
  function productNameOf(text) {
    return normText((text || '').replace(/\s*\d{8,}\s*$/, ''));
  }

  /** 文本归一化（去空格和标点），用于模糊比对剧名 */
  function normText(s) {
    return (s || '').replace(/[\s，,、。.！!？?：:；;（）()\[\]【】"'“”‘’]/g, '');
  }

  /**
   * 提交搜索
   * 这个界面的搜索不是回车触发的，而是 input 的 change 事件；
   * 程序化改值不会产生浏览器 dirty 标记，blur 也不会带出 change，必须手动派发
   */
  function commitSearch(input) {
    if (!input) return;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  }

  /** 找出所有以某文字开头的下拉选项 */
  function findOptionsStartingWith(text) {
    var out = [];
    var boxes = document.querySelectorAll('.el-select-dropdown');
    for (var b = 0; b < boxes.length; b++) {
      var box = boxes[b];
      var cs;
      try { cs = getComputedStyle(box); } catch (e) { continue; }
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var lis = box.querySelectorAll('li');
      for (var i = 0; i < lis.length; i++) {
        var t = (lis[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.indexOf(text) === 0) out.push(lis[i]);
      }
    }
    return out;
  }

  /**
   * 逐字符「打字」
   * 这个下拉的输入框在下拉打开后 readOnly=false，
   * 但一次性赋值会被组件丢掉，必须一个字符一个字符地派发事件
   */
  async function typeChars(el, text) {
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    var setter = null;
    try {
      setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    } catch (e) {}

    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      try { el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true })); } catch (e) {}
      try {
        el.dispatchEvent(new KeyboardEvent('keypress', {
          key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0),
          bubbles: true, cancelable: true
        }));
      } catch (e) {}
      try {
        var next = (el.value || '') + ch;
        if (setter) setter.call(el, next); else el.value = next;
      } catch (e) {}
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' })); } catch (e) {}
      try { el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true })); } catch (e) {}
      await sleep(160);
    }
    return true;
  }

  /** 确认这个 select 的下拉真的展开了 */
  async function ensureDropdownOpen(input) {
    for (var attempt = 0; attempt < 3; attempt++) {
      // aria-expanded 最可靠
      var exp = input.getAttribute && input.getAttribute('aria-expanded');
      if (exp === 'true') return true;

      var boxes = document.querySelectorAll('.el-select-dropdown');
      for (var i = 0; i < boxes.length; i++) {
        var cs;
        try { cs = getComputedStyle(boxes[i]); } catch (e) { continue; }
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (boxes[i].querySelector('li')) {
          // 有可见且带选项的下拉，认为已展开
          if (boxes[i].offsetParent !== null || cs.position === 'fixed') return true;
        }
      }
      forceClickOne(input);
      await sleep(900);
    }
    return false;
  }

  /**
   * 商品库这类下拉：
   *   点开（此时输入框解除只读）→ 清空 → 逐字符输入 → 点过滤出来的选项 → 收起下拉
   */
  async function pickSelectOption(input, text) {
    if (!input) return false;
    // 已经选中了（显示形如 示例商品库(1000001)）
    if ((input.value || '').indexOf(text) >= 0 && (input.value || '').indexOf('(') >= 0) return true;

    var opened = await ensureDropdownOpen(input);
    log('    · 下拉已展开：' + (opened ? '是' : '否'));
    if (!opened) return false;

    // 展开后输入框才会解除只读
    var editable = await waitFor(function () { return input.readOnly === false; }, 3000, 200);
    log('    · 输入框可输入：' + (editable ? '是' : '否'));

    // 清空当前内容
    try {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
    } catch (e) {
      try { input.value = ''; } catch (e2) {}
    }
    try { input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' })); } catch (e) {}
    await sleep(350);

    // 逐字符输入
    await typeChars(input, text);
    await sleep(2400);

    var matches = findOptionsStartingWith(text);
    if (!matches.length) {
      await sleep(1800);
      matches = findOptionsStartingWith(text);
    }
    if (!matches.length) {
      var total = document.querySelectorAll('.el-select-dropdown li').length;
      log('    · 输入「' + text + '」后没有匹配选项（框内：' + (input.value || '空') +
          '，下拉共 ' + total + ' 项）', 'err');
      return false;
    }

    // 多个同名库时，优先 1512004（模板用的那个）
    var chosen = matches[0];
    for (var k = 0; k < matches.length; k++) {
      if ((matches[k].textContent || '').indexOf('1512004') >= 0) { chosen = matches[k]; break; }
    }
    log('    · 选中选项：' + (chosen.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) +
        '（共 ' + matches.length + ' 个匹配）');
    forceClickOne(chosen);
    await sleep(1800);

    // 收起下拉：只让输入框失焦（不能按 Esc，那会把整个弹窗关掉）
    try { input.blur(); } catch (e) {}
    await sleep(600);

    return (input.value || '').indexOf(text) >= 0;
  }

  /** 「请选择落地页」抽屉 */
  function getLandingDrawer() {
    var list = document.querySelectorAll('.cl-drawer');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.indexOf('请选择落地页') >= 0 || t.indexOf('落地页分配规则') >= 0) return el;
    }
    return null;
  }

  /** 在「选择推广产品」弹窗里定位「商品库」输入框（结构定位，不依赖 placeholder 的具体值） */
  function getLibraryInput(d) {
    if (!d) return null;
    var ins = d.querySelectorAll('input');
    for (var i = 0; i < ins.length; i++) {
      if (!visible(ins[i])) continue;
      if ((ins[i].placeholder || '').indexOf('商品库') >= 0) return ins[i];
    }
    var near = findInputNearLabel(d, '商品库');
    if (near) return near;

    var allSel = d.querySelectorAll('.el-select');
    var filters = [];
    for (var s = 0; s < allSel.length; s++) {
      if (String(allSel[s].className || '').indexOf('cl-filter-select') >= 0) filters.push(allSel[s]);
    }
    if (filters.length >= 2) return filters[1].querySelector('input');
    if (filters.length === 1) return filters[0].querySelector('input');
    return null;
  }

  /** 读「已选素材：N」里的数字 */
  function readSelectedCount(root) {
    if (!root) return -1;
    var t = (root.textContent || '').replace(/\s+/g, ' ');
    var m = t.match(/已选素材[：:]\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
    m = t.match(/已选[：:]\s*(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  }


  function getProductDialog() {
    var list = document.querySelectorAll('.el-dialog, .cl-dialog, [role="dialog"]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 200) continue;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.indexOf('选择推广产品') >= 0) return el;
    }
    return null;
  }

  /**
   * 勾选产品列表里的第一项（异步：Vue 重渲染有延迟，必须等一拍再校验）
   * 注意：原生 input 是 0×0 且 opacity:0，直接点无效，必须点 label.el-checkbox
   */
  async function checkProductItem(root, keyword) {
    if (!root) return null;
    var labels = root.querySelectorAll('label.el-checkbox');
    var fallback = null;
    for (var i = 0; i < labels.length; i++) {
      var lb = labels[i];
      if (!visible(lb)) continue;
      var t = (lb.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (!fallback) fallback = { el: lb, t: t };
      if (keyword && t.indexOf(keyword) >= 0) {
        await clickLabelCheckbox(lb);
        return t;
      }
    }
    if (fallback) {
      await clickLabelCheckbox(fallback.el);
      return fallback.t;
    }
    return null;
  }

  async function clickLabelCheckbox(lb) {
    if (isLabelChecked(lb)) return true;
    forceClickOne(lb);
    await sleep(400);
    if (isLabelChecked(lb)) return true;
    var inner = lb.querySelector('.el-checkbox__inner');
    if (inner) {
      forceClickOne(inner);
      await sleep(400);
    }
    return isLabelChecked(lb);
  }

  function isLabelChecked(lb) {
    if (!lb) return false;
    if (lb.tagName === 'INPUT' && lb.type === 'checkbox') return !!lb.checked;
    if (String(lb.className || '').indexOf('is-checked') >= 0) return true;
    var cb = lb.querySelector('input[type="checkbox"]');
    return !!(cb && cb.checked);
  }

  /**
   * 按「列」定位按钮
   * 页面是 5 列表格：广告信息 / 定向模板 / 创意信息 / 创意素材 / 落地页
   * 每列都有自己的「编辑」「添加」「清空」「选择素材」，光按文字找会点错列
   */
  function getColumnLeft(sectionTitle) {
    var list = document.querySelectorAll('div,span');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (t !== sectionTitle) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 220 || r.height < 6 || r.height > 40) continue;
      return r.left;
    }
    return null;
  }

  function findColumnAction(sectionTitle, actionText) {
    var cx = getColumnLeft(sectionTitle);
    var list = document.querySelectorAll('button,span,a,div');
    var cands = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el) || isDisabled(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (t !== actionText) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 14) continue;
      var dx = (cx == null) ? 0 : Math.abs(r.left - cx);
      cands.push({ el: el, r: r, dx: dx, isBtn: el.tagName === 'BUTTON' });
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) {
      if (a.isBtn !== b.isBtn) return a.isBtn ? -1 : 1;
      if (Math.abs(a.dx - b.dx) > 40) return a.dx - b.dx;
      return a.r.width - b.r.width;
    });
    return cands[0].el;
  }

  /** 按列点按钮，并返回诊断信息 */
  function clickColumnAction(sectionTitle, actionText) {
    var el = findColumnAction(sectionTitle, actionText);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    log('  · 点「' + sectionTitle + '」列的「' + actionText + '」(' +
        Math.round(r.left) + ',' + Math.round(r.top) + ')');
    forceClickOne(el);
    return el;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    var cls = String(el.className || '');
    if (cls.indexOf('is-disabled') >= 0 || cls.indexOf('disabled') >= 0) return true;
    var p = el.closest ? el.closest('button') : null;
    if (p && p.disabled) return true;
    return false;
  }

  /**
   * 强制点击：
   *  1) scrollIntoView 滚到中心
   *  2) 直接在目标元素 el 上多发事件链（pointerdown/mousedown/click/...）
   *  3) 用原生 el.click() 兜底
   *  关键：React/AntD 的合成事件绑在外层组件（比如 el-button），内部包的 span/div
   *       没有事件，所以**必须对 el（findAndClick 找到的那个元素本身）**打事件，
   *       不能用 elementFromPoint 找顶层元素替代
   */
  function forceClickOne(el, opts) {
    opts = opts || {};
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}

    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;

    // 视口保护：滚动后目标可能暂时还在视口外一点点
    if (cx < 2) cx = 2;
    if (cy < 2) cy = 2;
    if (cx > window.innerWidth - 2) cx = window.innerWidth - 2;
    if (cy > window.innerHeight - 2) cy = window.innerHeight - 2;

    // 只发一次 click（复选框/下拉这类开关，点两次等于没点）
    var events = ['pointerdown', 'mousedown', 'mouseenter', 'mouseover',
                  'pointermove', 'mousemove', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < events.length; i++) {
      try {
        el.dispatchEvent(new MouseEvent(events[i], {
          bubbles: true, cancelable: true, view: window,
          clientX: cx, clientY: cy, button: 0
        }));
      } catch (e) {}
    }

    // 只有显式要求时才补一次原生 click
    if (opts.double) {
      try { el.click(); } catch (e) {}
    }

    return { el: el, rect: r };
  }

  /** 批量找候选 + 点击 */
  function findAndClick(text, opts) {
    opts = opts || {};
    var tags = opts.tags || 'button,span,div,a,label,i';
    var exact = opts.exact !== false;  // 默认精确匹配
    var prefer = opts.prefer || 'first';
    var root = opts.inDialog ? (getVisibleDialog() || document) : document;
    var allowDisabled = !!opts.allowDisabled;
    var minSize = opts.minSize || 0;  // 候选元素最小尺寸

    var list = root.querySelectorAll(tags);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (minSize > 0 && (r.width < minSize || r.height < minSize)) continue;
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (exact ? t !== text : t.indexOf(text) < 0) continue;
      if (!allowDisabled && isDisabled(el)) continue;
      out.push({ el: el, r: r, t: t });
    }
    if (!out.length) return null;

    var target = out[0];
    if (prefer === 'bottom') {
      var sMax = -1;
      for (var j = 0; j < out.length; j++) {
        var s = out[j].r.top + out[j].r.right;
        if (s > sMax) { sMax = s; target = out[j]; }
      }
    } else if (prefer === 'top') {
      var tMin = 1e9;
      for (var k = 0; k < out.length; k++) {
        if (out[k].r.top < tMin) { tMin = out[k].r.top; target = out[k]; }
      }
    } else if (prefer === 'smallestX') {
      var xMin = 1e9;
      for (var m = 0; m < out.length; m++) {
        if (out[m].r.x < xMin) { xMin = out[m].r.x; target = out[m]; }
      }
    }

    log('  ▶ 找到 ' + out.length + ' 个候选，选中「' + target.t +
      '」(' + Math.round(target.r.x) + ',' + Math.round(target.r.y) + ')，clicking');
    var hit = forceClickOne(target.el);
    return hit ? hit.el : null;
  }

  /** 原生 setter 赋值（兼容 React/AntD 的受控组件） */
  function setInputValue(el, value) {
    if (!el) return false;
    try {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
    } catch (e) {
      try { el.value = value; } catch (e2) { return false; }
    }
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e3) {}
    return el.value === value || (el.value || '').indexOf(value) === 0;
  }

  function findSearchInput(root) {
    root = root || getVisibleDialog() || document;
    var inputs = root.querySelectorAll('input');
    var cand = null;
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (!visible(inp)) continue;
      if (inp.type === 'checkbox' || inp.type === 'radio' || inp.readOnly) continue;
      var ph = inp.placeholder || '';
      if (ph.indexOf('关键词') >= 0 || ph.indexOf('搜索') >= 0 ||
          ph.indexOf('名称') >= 0 || ph.indexOf('请输入') >= 0) return inp;
      if (!cand) cand = inp;
    }
    return cand;
  }

  /**
   * 勾选表格里的一行。
   * 关键：不能只信「点之前 cb.checked 就是 true」——表格是虚拟列表，
   * 行会被复用，复用的 checkbox 可能还留着上一行的 checked 状态，
   * 直接 return true 会导致「以为勾上了、其实没勾」，最终只剩 1 个账户。
   * 所以这里点完必须回读真实状态。
   */
  function checkRow(row) {
    if (!row) return false;
    var cb = row.querySelector('input[type="checkbox"]');
    if (cb) {
      if (isDisabled(cb)) return false;
      if (cb.checked) return true;
      forceClickOne(cb);
      if (!cb.checked) {
        var wrap = cb.closest('label, .el-checkbox, .ant-checkbox-wrapper, .ant-checkbox, .el-checkbox-wrapper');
        if (wrap) forceClickOne(wrap);
      }
      return !!cb.checked;
    }
    var role = row.querySelector('[role="checkbox"]');
    if (role) {
      forceClickOne(role);
      var after = role.getAttribute('aria-checked');
      return after === 'true' || String(role.className || '').indexOf('checked') >= 0;
    }
    return false;
  }

  /**
   * 带重试的 findAndClick
   * 针对那些需要等待 / 可能被遮挡的步骤用
   */
  async function findAndClickWithRetry(text, opts, retries) {
    retries = retries == null ? 3 : retries;
    for (var t = 0; t < retries; t++) {
      var el = findAndClick(text, opts);
      if (el) return el;
      log('  · 未找到「' + text + '」，第 ' + (t + 1) + '/' + retries + ' 次重试...');
      await sleep(600);
    }
    return null;
  }

  /**
   * 通用：如果弹窗里有「取消 / 确认(确定)」这种二次确认，就点确认
   * hint：弹窗正文里应该包含的关键字（用来确认点对了弹窗，可选）
   */
  async function dismissConfirmIfAny(hint, waitMs) {
    waitMs = waitMs == null ? 3000 : waitMs;
    var found = await waitFor(function () {
      var d = getVisibleDialog();
      if (!d) return false;
      if (!hint) return true;
      return (d.textContent || '').indexOf(hint) >= 0;
    }, waitMs, 300);

    var dlg = getVisibleDialog();
    if (!dlg) return false;
    if (hint && (dlg.textContent || '').indexOf(hint) < 0) return false;

    var btn = findDialogConfirm(dlg);
    if (!btn) return false;

    log('  · 二次确认弹窗出现，点「' + (btn.textContent || '').replace(/\s+/g, '') + '」');
    forceClickOne(btn);
    await waitFor(function () {
      var d = getVisibleDialog();
      return !d || (hint ? (d.textContent || '').indexOf(hint) < 0 : false);
    }, 4000, 250);
    return true;
  }

  /* -------------------- 多账户（一个广告挂 N 个账户）公共工具 -------------------- */

  /** 每个账户对应的短剧；没有 dramas 就用同一个 drama 铺满 */
  function ctxDramas(ctx) {
    var out = [];
    var n = (ctx.accounts || []).length;
    if (ctx.dramas && ctx.dramas.length === n) return ctx.dramas.slice();
    for (var i = 0; i < n; i++) out.push(ctx.drama);
    return out;
  }

  /**
   * 是否按「统一模式」执行 —— 以面板上用户选的那个页签为准。
   * byAccount=true（多账户/分账户）→ 即使所有账户填的是同一部剧，也照样逐个账户设置；
   * byAccount=false（统一模式）→ 共用一份，不切账户。
   * 只有老调用（没带 byAccount）才退回"短剧名相同就当统一"的旧判断。
   */
  function ctxUnified(ctx) {
    if (typeof ctx.byAccount === 'boolean') return !ctx.byAccount;
    var ds = ctxDramas(ctx);
    if (ds.length <= 1) return true;
    var k0 = normText(ds[0]);
    for (var i = 1; i < ds.length; i++) {
      if (normText(ds[i]) !== k0) return false;
    }
    return true;
  }

  /**
   * 落地页是否必须「按账户分配」
   * 多账户不同剧时本来就要按账户；另外只要启用了售卖策略，
   * 即使是统一模式（同一部剧）也必须按账户——同名落地页可能分属不同账户，
   * 「统一配置」会把同一条挂给所有账户，直接挂错。
   */
  function landingSplitNeeded(ctx) {
    return !ctxUnified(ctx) || !!ctx.strategy;
  }

  /** 只看"渲染出来了没有"，不要求 offsetParent（弹窗里的 inline 元素常被判成不可见） */
  function looseVisible(el) {
    if (!el) return false;
    var cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }

  /** 弹窗/抽屉左侧账户树里找账户节点（文字完全等于账户ID、面积最小） */
  function findAccountNode(root, id) {
    if (!root) return null;
    id = String(id).trim();
    // 1) 账号文本节点（title 里带账号号，最准）
    var byTitle = root.querySelectorAll('[title="' + id + '"]');
    for (var t1 = 0; t1 < byTitle.length; t1++) {
      if (looseVisible(byTitle[t1])) return byTitle[t1];
    }
    var names = root.querySelectorAll('.account-name');
    for (var n = 0; n < names.length; n++) {
      if (!looseVisible(names[n])) continue;
      if ((names[n].textContent || '').replace(/\s+/g, '') === id) return names[n];
    }
    // 账号可能是只读 input（没有文字节点）
    var inps = root.querySelectorAll('input');
    for (var i2 = 0; i2 < inps.length; i2++) {
      if (!looseVisible(inps[i2])) continue;
      if (String(inps[i2].value || '').trim() === id) return inps[i2];
    }
    var all = root.querySelectorAll('div, span, li, p, a, td, dd, dt, label');
    var best = null, bestArea = 1e18;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!looseVisible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (!t) continue;
      var digits = t.replace(/[^\d]/g, '');     // 去掉「账户：」「(备注)」等杂字符再比
      var okTxt = (t === id) ||
                  (t.indexOf(id) === 0 && t.length <= id.length + 6) ||
                  (digits === id);
      if (!okTxt) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 320) continue;
      var area = r.width * r.height;
      if (area < bestArea) { bestArea = area; best = el; }
    }
    return best;
  }

  /** 数一下这批账户在容器里能定位到几个（用于「按账户分配」左侧树是否就绪） */
  function countAccountNodes(root, ids) {
    var n = 0;
    for (var i = 0; i < ids.length; i++) {
      if (findAccountNode(root, ids[i])) n++;
    }
    return n;
  }

  /** 判断某个「单选/切换项」当前是否已激活 */
  function isChoiceActive(el) {
    var n = el;
    for (var up = 0; up < 3 && n; up++) {
      var cls = String(n.className || '');
      if (cls.indexOf('is-active') >= 0 || cls.indexOf('is-checked') >= 0) return true;
      var cb = n.querySelector ? n.querySelector('input[type="radio"], input[type="checkbox"]') : null;
      if (cb && cb.checked) return true;
      n = n.parentElement;
    }
    return false;
  }

  /**
   * 找「分配规则」里的某张卡片（例：平均分配 / 分账户选择）
   * 这类卡片文案是「标题 + 推荐角标 + 一句说明」，不能用完全等于去匹配；
   * 先找文字完全等于标题的最小元素，再往上找可点的卡片容器
   */
  function findRuleCard(root, label) {
    if (!root) return null;
    label = String(label).replace(/\s+/g, '');
    var list = root.querySelectorAll('span, div, label, p, b, em, a, li');
    var leaf = null, leafArea = 1e18;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (t !== label) continue;
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (area <= 0) continue;
      if (area < leafArea) { leafArea = area; leaf = el; }
    }
    if (!leaf) {
      // 兜底：以标题开头、且只比标题长一点点（说明文案）
      for (var j = 0; j < list.length; j++) {
        var e2 = list[j];
        if (!visible(e2)) continue;
        var t2 = (e2.textContent || '').replace(/\s+/g, '').trim();
        if (t2.indexOf(label) !== 0 || t2.length > label.length + 20) continue;
        var r2 = e2.getBoundingClientRect();
        if (r2.width < 40 || r2.width > 460 || r2.height < 20) continue;
        var a2 = r2.width * r2.height;
        if (a2 < leafArea) { leafArea = a2; leaf = e2; }
      }
    }
    if (!leaf) return null;
    // 从标题文字往上包几层，直到快把旁边的卡片也包进来为止
    var card = leaf;
    var p = leaf.parentElement;
    for (var up = 0; up < 3 && p; up++) {
      var pt = (p.textContent || '').replace(/\s+/g, '').trim();
      if (pt.length > label.length + 20) break;
      var pr = p.getBoundingClientRect();
      if (pr.width > 460) break;
      card = p;
      p = p.parentElement;
    }
    return card;
  }

  /**
   * 点一个「单选项」（分配到账户 / 分账户选择 / 按账户分配…）
   * labels 可以传字符串或数组；支持"标题 + 副标题"这种文案（前缀匹配）
   */
  async function activateChoice(root, labels) {
    if (!root) return false;
    if (typeof labels === 'string') labels = [labels];
    labels = labels || [];

    var pick = function () {
      var list = root.querySelectorAll('label.el-radio-button, .el-radio-button, label, span, button, div, a, li');
      var best = null, bestArea = 1e18, bestActive = false;
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!visible(el)) continue;
        var t = (el.textContent || '').replace(/\s+/g, '').trim();
        if (!t) continue;
        var hit = false;
        for (var k = 0; k < labels.length; k++) {
          var lb = labels[k];
          if (!lb) continue;
          if (t === lb) { hit = true; break; }
          if (t.indexOf(lb) === 0 && t.length <= lb.length + 10) { hit = true; break; }
        }
        if (!hit) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) continue;
        var area = r.width * r.height;
        if (area < bestArea) {
          bestArea = area; best = el;
          bestActive = isChoiceActive(el);
        }
      }
      return best ? { el: best, active: bestActive } : null;
    };

    var f = pick();
    if (!f) return false;
    if (f.active) return true;

    forceClickOne(f.el);
    await sleep(1300);
    var f2 = pick();
    if (f2 && !f2.active) {       // 有的组件要点两次才切换
      forceClickOne(f2.el);
      await sleep(1100);
    }
    return true;
  }

  /**
   * 切换分配规则时会弹「提示」确认框（例：使用「全部相同」会重置所有账户已选产品，是否继续？）
   * 只处理这种小确认框，别把主弹窗当确认框关掉
   */
  async function confirmTipIfAny() {
    var list = document.querySelectorAll('.el-message-box, .el-dialog');
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!visible(d)) continue;
      var t = (d.textContent || '').replace(/\s+/g, ' ');
      if (t.indexOf('是否继续') < 0) continue;
      var r = d.getBoundingClientRect();
      if (r.width > 520) continue;
      var ok = findDialogButton(d, ['确定', '确认']);
      if (ok) {
        forceClickOne(ok);
        log('    · 已确认规则切换提示（' + t.replace(/\s+/g, '').slice(0, 26) + '…）');
        await sleep(1200);
        return true;
      }
    }
    return false;
  }

  /** 弹窗/抽屉里是否还在加载 */
  function panelBusy(root) {
    if (!root) return false;
    var lds = root.querySelectorAll('.el-loading-mask, .el-loading-spinner, .is-loading');
    for (var i = 0; i < lds.length; i++) if (visible(lds[i])) return true;
    var t = (root.textContent || '');
    if (t.indexOf('加载中') >= 0) return true;
    return false;
  }

  /**
   * 判断根节点是否属于「数据源下拉」场景（vs 左侧账户列表场景）
   * 数据源下拉：弹窗里没有 .account-wrapper/.account-name 左侧列表，
   * 而是有 >= 2 个宽 >= 100px 的可见 .el-select（账户下拉 + 商品库下拉）。
   * 这种场景下 clickAccountRow 必须走 switchAccountViaSelect，
   * 不能走 findAccountNode + 左侧列表点击逻辑（因为 findAccountNode 会误匹配 el-select input.value）。
   */
  function isDataSourceSelectMode(root) {
    if (!root) return false;
    // 有左侧列表特征 → 不是数据源下拉
    var aw = root.querySelector('.account-wrapper, .account-content-wrapper');
    if (aw && looseVisible(aw)) return false;
    // 没有左侧列表，再看有没有 >= 2 个宽的 .el-select
    var selects = root.querySelectorAll('.el-select');
    var bigSelects = 0;
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      if (!looseVisible(sel)) continue;
      var r = sel.getBoundingClientRect();
      if (r.width >= 100) bigSelects++;
    }
    return bigSelects >= 2;
  }

  /**
   * 平台两种「分配到账户」UI 形态都能正确识别账户
   * 1) 左侧账户列表：根节点里有 .account-wrapper / .account-name / [title="账户ID"]
   * 2) 数据源下拉：根节点里没有 account-wrapper，但某个可见 .el-select 的 value 或下拉选项里能找到该账户 ID
   */
  function findAccountNodeAny(root, acc) {
    // 先试标准 DOM 节点（findAccountNode 覆盖了 title、.account-name、input.value 等）
    var n = findAccountNode(root, acc);
    if (n) return n;
    // 再试数据源下拉里的 option
    var selects = (root || document).querySelectorAll('.el-select');
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      var inp = sel.querySelector('input');
      var cur = (inp && (inp.value || inp.textContent) || '').trim();
      if (cur === acc) return sel;   // 当前选中的就是这个账户
      // 也要看 input 本身的 title/placeholder
      if ((inp && (inp.title || inp.placeholder) || '').indexOf(acc) >= 0) return sel;
    }
    return null;
  }

  /**
   * 数据源下拉模式：点击 el-select → 找匹配的 option → 点击切换账户
   */
  async function switchAccountViaSelect(dlg, acc) {
    if (!dlg) return false;
    var selects = dlg.querySelectorAll('.el-select');
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      var inp = sel.querySelector('input');
      if (!inp) continue;
      var cur = (inp.value || '').trim();
      if (cur === acc) return true;          // 当前就是，不用切
      var r = sel.getBoundingClientRect();
      if (r.width < 100) continue;           // 太窄不是账户下拉（可能是商品库）
      if (!looseVisible(sel)) continue;

      // 点击策略：依次尝试 箭头图标 → input → 整个 select 容器，确保能打开下拉
      var caret = sel.querySelector('.el-select__caret, .el-input__icon, i.el-input__icon');
      if (caret && looseVisible(caret)) forceClickOne(caret);
      else forceClickOne(inp);
      await sleep(500);
      // 兜底：如果下拉还没出来，再点一次容器
      var allPanels = document.querySelectorAll('.el-select-dropdown, .el-popper');
      var panelOpen = false;
      for (var pp = 0; pp < allPanels.length; pp++) {
        var cs2 = getComputedStyle(allPanels[pp]);
        if (cs2.display !== 'none' && allPanels[pp].getBoundingClientRect().width >= 80) { panelOpen = true; break; }
      }
      if (!panelOpen) {
        forceClickOne(sel);
        await sleep(500);
      }

      // 找打开的 select dropdown 面板
      var panel = null;
      allPanels = document.querySelectorAll('.el-select-dropdown, .el-popper');
      for (var j = 0; j < allPanels.length; j++) {
        var cp = allPanels[j];
        if (cp.getAttribute && cp.getAttribute('aria-hidden') === 'true') continue;
        var cs = getComputedStyle(cp);
        if (cs.display === 'none') continue;
        var cr = cp.getBoundingClientRect();
        if (cr.width < 80) continue;
        var txt = (cp.textContent || '').replace(/\s+/g, '');
        if (txt.indexOf(acc) >= 0) { panel = cp; break; }
      }

      if (panel) {
        var opts = panel.querySelectorAll('.el-select-dropdown__item, li[role="option"]');
        var bestOpt = null;
        for (var k = 0; k < opts.length; k++) {
          var otxt = (opts[k].textContent || '').replace(/\s+/g, '');
          var digits = otxt.replace(/[^\d]/g, '');
          if (otxt === acc || digits === acc || otxt.indexOf(acc) === 0) {
            bestOpt = opts[k];
            break;
          }
        }
        if (bestOpt) {
          forceClickOne(bestOpt);
          await sleep(900);
          // 校验：下拉关闭后再读一次 input.value
          await sleep(400);
          var newVal = (inp.value || '').trim();
          if (newVal === acc) return true;
          return true;   // 没回读到也先算成功（可能 input 还没刷新）
        }
        forceClickOne(document.body);  // 没找到就关掉下拉
      } else {
        forceClickOne(document.body);
      }
    }
    return false;
  }

  /**
   * 点左侧账户列表里的某个账户（左侧列表模式）
   * 实测（2026-11-04，真实「选择推广产品」弹窗）：点账户号文字（span.account-name）就能切换，
   * 行右侧的圆勾图标（i.mg-icon-right-big）点了没反应；售卖策略那类弹窗反而认右侧图标。
   * 所以顺序是「账户名 → 右侧图标 → 整行」兜底。切成功后行容器 .account-content-wrapper 带 checked。
   * 返回 true = 已切换（或该弹窗没有 checked 机制，按已切换处理）
   */
  async function clickAccountRow(root, acc) {
    // 先判断是不是数据源下拉场景 —— 如果是，直接走 el-select 下拉切换，
    // 不能走下面 findAccountNode + 左侧列表点击逻辑，
    // 因为 findAccountNode 会误匹配 el-select input.value，
    // 导致进入左侧列表逻辑（点 readonly input）然后假阳性 return true。
    if (isDataSourceSelectMode(root)) {
      var viaSel = await switchAccountViaSelect(root, acc);
      if (viaSel) return true;
      if (root !== document) {
        var viaDoc2 = await switchAccountViaSelect(document, acc);
        if (viaDoc2) return true;
      }
      return false;
    }

    var node = findAccountNode(root, acc);
    if (!node) {
      // 左侧列表里找不到 —— 试试数据源下拉模式（兜底）
      if (root && root.querySelectorAll('.el-select').length > 0) {
        var viaSelect = await switchAccountViaSelect(root, acc);
        if (viaSelect) return true;
      }
      if (root !== document) {
        var viaDoc = await switchAccountViaSelect(document, acc);
        if (viaDoc) return true;
      }
      return false;
    }

    var hasCheckedStyle = !!(root && root.querySelector && root.querySelector('.account-content-wrapper'));

    // 找到整行容器
    var wrap = null;
    var cur = node;
    for (var up = 0; up < 5 && cur; up++) {
      if (String(cur.className || '').indexOf('account-content-wrapper') >= 0) { wrap = cur; break; }
      cur = cur.parentElement;
    }
    if (!wrap) {
      cur = node;
      for (var up2 = 0; up2 < 4 && cur; up2++) {
        if (String(cur.className || '').indexOf('account-wrapper') >= 0) { wrap = cur; break; }
        cur = cur.parentElement;
      }
    }
    if (!wrap) wrap = node.parentElement || node;

    var isChecked = function () {
      return String((wrap && wrap.className) || '').indexOf('checked') >= 0;
    };

    var icon = wrap.querySelector('i.mg-icon-tips-green') ||
               wrap.querySelector('.account-icon-wrapper i') ||
               wrap.querySelector('.account-icon-wrapper');

    // 1) 先点账户名本身
    //    2026-11-04 在真实「选择推广产品」弹窗实测：点账户号（span.account-name）就能切换，
    //    点右侧那个圆勾图标反而没反应（图标是 mg-icon-right-big，不是绿勾）
    if (!isChecked()) {
      forceClickOne(node);
      await sleep(800);
    }

    // 2) 右侧图标（售卖策略这类弹窗认这个）
    if (icon && !isChecked()) {
      forceClickOne(icon);
      await sleep(800);
    }

    // 3) 整行兜底
    if (!isChecked()) {
      forceClickOne(wrap);
      await sleep(600);
    }

    // 等该账户的数据加载完
    var t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (!panelBusy(root)) break;
      await sleep(300);
    }
    await sleep(300);

    if (!hasCheckedStyle) return true;   // 这个弹窗没有 checked 标记，只能认为已切换
    return isChecked();
  }

  /**
   * 「选择推广产品」里那个「清空」按钮
   * 弹窗里其实有 4 个 class 完全相同的「清空」（每个账户一张卡片），
   * 只能按「已选：N」这个锚点找离它最近的那个，否则会点到别的账户的
   */
  function findClearInDialog(dlg) {
    if (!dlg) return null;
    var anchor = null;
    var nodes = dlg.querySelectorAll('span, div');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.indexOf('已选') !== 0 || t.length > 10) continue;
      if (!/^已选[：:]?\d/.test(t)) continue;
      anchor = el.getBoundingClientRect();
      break;
    }
    var best = null, bestD = 1e9;
    var btns = dlg.querySelectorAll('button, a, span');
    for (var k = 0; k < btns.length; k++) {
      var b = btns[k];
      if (!visible(b) || isDisabled(b)) continue;
      if ((b.textContent || '').replace(/\s+/g, '').trim() !== '清空') continue;
      var r = b.getBoundingClientRect();
      if (r.width > 90 || r.height > 34) continue;
      var d = anchor
        ? (Math.abs((r.top + r.height / 2) - (anchor.top + anchor.height / 2)) * 3 + Math.abs(r.left - anchor.left))
        : (r.left + r.top);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /** 清空确认框（只在真的是"确认清空"时才点确定） */
  function findClearConfirm() {
    var list = document.querySelectorAll('.el-message-box, .el-dialog');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (t.indexOf('清空') < 0) continue;
      if (t.indexOf('确定清空') < 0 && t.indexOf('是否清空') < 0 && t.indexOf('确认清空') < 0) continue;
      var b = findDialogButton(el, ['确定', '确认']);
      if (b) return b;
    }
    return null;
  }

  /** 素材抽屉顶部的账户 tab（文案形如「账户1: 10000001」） */
  async function clickAccountTab(dr, acc) {
    if (!dr) return false;
    var list = dr.querySelectorAll('div, span, a, li, p');
    var best = null, bestArea = 1e18;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.indexOf(acc) < 0 || t.indexOf('账户') < 0 || t.length > 40) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 260 || r.height > 40) continue;
      var area = r.width * r.height;
      if (area < bestArea) { bestArea = area; best = el; }
    }
    if (!best) return false;
    forceClickOne(best);
    await sleep(1200);
    return true;
  }

  /** 「选择推广产品」里按剧名搜索（逐字符 + change 触发） */
  async function searchProductName(d, drama) {
    var ins = d.querySelectorAll('input');
    var input = null;
    for (var i = 0; i < ins.length; i++) {
      if (!visible(ins[i])) continue;
      var ph = ins[i].placeholder || '';
      if (ph.indexOf('关键词') >= 0 || ph.indexOf('搜索') >= 0) { input = ins[i]; break; }
    }
    if (!input) throw new Error('没找到「请输入关键词」搜索框');

    var clearIcon = null;
    var wraps = input.parentElement ? input.parentElement.querySelectorAll('i, span') : [];
    for (var ci = 0; ci < wraps.length; ci++) {
      var cls = String(wraps[ci].className || '');
      if (cls.indexOf('clear') >= 0 || cls.indexOf('close') >= 0) { clearIcon = wraps[ci]; break; }
    }
    if (clearIcon) { forceClickOne(clearIcon); await sleep(500); }
    try { input.readOnly = false; input.removeAttribute('readonly'); } catch (e) {}
    forceClickOne(input);
    await sleep(400);
    input.value = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
    await sleep(300);

    await typeChars(input, drama);
    await sleep(700);
    input.focus();
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    } catch (e) {}
    commitSearch(input);
    await sleep(3000);

    var labels = d.querySelectorAll('label.el-checkbox');
    var key = normText(drama);
    var matched = false;
    for (var k = 0; k < labels.length; k++) {
      if (productNameOf(labels[k].textContent) === key) { matched = true; break; }
    }
    if (!matched) { commitSearch(input); await sleep(3000); }
    log('    · 搜索「' + drama + '」后列表 ' + labels.length + ' 项');
  }

  /** 勾选剧名完全一致的那条；同名多条时暂停让用户手动挑 */
  async function pickProductByName(d, drama, tag) {
    tag = tag || '';
    var key = normText(drama);
    var labels = d.querySelectorAll('label.el-checkbox');
    var matches = [];
    for (var i = 0; i < labels.length; i++) {
      if (!visible(labels[i])) continue;
      if (productNameOf(labels[i].textContent) === key) matches.push(labels[i]);
    }
    if (!matches.length) {
      throw new Error(tag + '列表里没有「' + drama + '」（搜索没生效或不在当前商品库）');
    }
    if (matches.length > 1) {
      log('⚠ ' + tag + '发现 ' + matches.length + ' 个同名短剧，暂停让你手动选', 'err');
      for (var m = 0; m < matches.length; m++) {
        log('    [' + (m + 1) + '] ' + (matches[m].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50), 'err');
      }
      log('👉 手动勾选正确的那一条，然后点面板「继续」', 'err');
      STATE.paused = true;
      updateStatus();
      setStep('⏸ 等你手动选择同名短剧（选完点「继续」）');
      expandFromBall();
      await waitFor(function () { return !STATE.paused || STATE.stopped; }, 900000, 500);
      if (STATE.stopped) return false;
      collapseToBall('running');
      log('▶ 已接管完成，继续', 'ok');
      return true;
    }
    var was = isLabelChecked(matches[0]);
    await clickLabelCheckbox(matches[0]);
    log('    · 已勾选「' + drama + '」' + (was ? '（原本已勾）' : ''), 'ok');
    await sleep(600);
    return true;
  }

  /** 素材抽屉：清空当前账户的素材 */
  async function creativeClear(dr) {
    var btn = findDialogButton(dr, ['清空']);
    if (btn) { forceClickOne(btn); log('    · 已清空该账户素材', 'ok'); await sleep(1200); }
    else log('    · 没找到「清空」（可能本来就没素材）', 'info');
  }

  /** 素材抽屉：批量添加 → 添加视频 → 等素材库出现 */
  async function creativeAddVideo(dr) {
    if (getMaterialDialog()) { log('    · 素材库已打开，跳过', 'info'); return; }
    var dd = null;
    var dds = dr.querySelectorAll('.el-dropdown, .el-dropdown-selfdefine');
    for (var i = 0; i < dds.length; i++) {
      var t = (dds[i].textContent || '').replace(/\s+/g, '');
      if (t.indexOf('批量添加') >= 0 && t.indexOf('组图') < 0) { dd = dds[i]; break; }
    }
    if (!dd) throw new Error('没找到「批量添加」下拉');

    var r = dd.getBoundingClientRect();
    var evs = ['pointerenter', 'mouseenter', 'pointerover', 'mouseover', 'mousemove'];
    for (var e1 = 0; e1 < evs.length; e1++) {
      try {
        dd.dispatchEvent(new MouseEvent(evs[e1], {
          bubbles: true, cancelable: true, view: window,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
        }));
      } catch (e) {}
    }
    await sleep(1200);

    var menu = null;
    var menus = document.querySelectorAll('.el-dropdown-menu');
    for (var m = menus.length - 1; m >= 0; m--) {
      if (visible(menus[m]) && (menus[m].textContent || '').indexOf('添加视频') >= 0) { menu = menus[m]; break; }
    }
    if (!menu) {
      forceClickOne(dd.querySelector('button') || dd);
      await sleep(1500);
      menus = document.querySelectorAll('.el-dropdown-menu');
      for (var m2 = menus.length - 1; m2 >= 0; m2--) {
        if (visible(menus[m2]) && (menus[m2].textContent || '').indexOf('添加视频') >= 0) { menu = menus[m2]; break; }
      }
    }
    if (!menu) {
      var allMenus = document.querySelectorAll('.el-dropdown-menu');
      for (var m3 = allMenus.length - 1; m3 >= 0; m3--) {
        if ((allMenus[m3].textContent || '').indexOf('添加视频') >= 0) { menu = allMenus[m3]; break; }
      }
      if (menu) log('    · 下拉没展开，直接从隐藏菜单里点');
    }
    if (!menu) throw new Error('没找到含「添加视频」的下拉菜单');

    var item = null;
    var lis = menu.querySelectorAll('li, .el-dropdown-menu__item');
    for (var j = 0; j < lis.length; j++) {
      if ((lis[j].textContent || '').replace(/\s+/g, '').trim() === '添加视频') { item = lis[j]; break; }
    }
    if (!item) throw new Error('下拉菜单里没有「添加视频」');

    forceClickOne(item);
    var opened = await waitFor(function () { return !!getMaterialDialog(); }, 12000, 400);
    if (!opened) throw new Error('点了「添加视频」但素材库没打开');
    await sleep(1200);
  }

  /** 素材库的搜索框（素材名称，占位符常是「关键词」） */
  function findMaterialSearchInput(d) {
    if (!d) return null;
    var inputs = d.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      if (!visible(inputs[i])) continue;
      if ((inputs[i].placeholder || '').indexOf('关键词') >= 0) return inputs[i];
    }
    for (var j = 0; j < inputs.length; j++) {
      var inp = inputs[j];
      if (!visible(inp)) continue;
      if (inp.type === 'checkbox' || inp.type === 'radio') continue;
      if ((inp.placeholder || '').indexOf('请选择') === 0) continue;
      return inp;
    }
    return null;
  }

  /** 容器里按文字找按钮（清空 / 收起），取最靠上、且最内层（面积最小）的那个 */
  function findTopTextButton(root, text) {
    if (!root) return null;
    var list = root.querySelectorAll('button, span, a, div, i');
    var pool = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      if ((el.textContent || '').replace(/\s+/g, '').trim() !== text) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 90 || r.height > 34) continue;
      pool.push({ el: el, top: r.top, area: r.width * r.height, kids: el.children.length });
    }
    // 先锁定「最上面那一档」（±8px），再优先取没有子元素的那个（文字节点本身，事件就绑在它上面）
    if (!pool.length) return null;
    var minTop = pool[0].top;
    for (var k = 1; k < pool.length; k++) if (pool[k].top < minTop) minTop = pool[k].top;
    var near = [];
    for (var j = 0; j < pool.length; j++) if (pool[j].top <= minTop + 8) near.push(pool[j]);
    near.sort(function (a, b) { return (a.kids - b.kids) || (a.area - b.area); });
    return near[0].el;
  }

  /** 去掉空白和末尾冒号，用于比对标签文字 */
  function normLabel(s) {
    return String(s || '').replace(/\s+/g, '').replace(/[：:]$/, '').trim();
  }

  /** 找筛选标签本身（「素材目录」/「素材目录：」都行），取最小的那个元素 */
  function findFilterLabel(root, text) {
    if (!root) return null;
    var want = normLabel(text);
    var list = root.querySelectorAll('label, span, div, p');
    var best = null, bestArea = 1e18;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      if (normLabel(el.textContent) !== want) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 160 || r.height > 34) continue;
      var a = r.width * r.height;
      if (a < bestArea) { bestArea = a; best = el; }
    }
    return best;
  }

  /**
   * 由「素材目录」标签直接定位它右边的下拉控件
   * 只在标签所在的那一行里找（最近优先），不跨行、不遍历整个弹窗
   */
  function findRowControls(labelEl) {
    if (!labelEl) return [];
    var lr = labelEl.getBoundingClientRect();
    var cy = lr.top + lr.height / 2;

    // 往上找到「够宽的一行」作为搜索范围，避免把别的筛选项也扫进来
    var scope = labelEl.parentElement;
    for (var up = 0; up < 3 && scope; up++) {
      var sr = scope.getBoundingClientRect();
      if (sr.width >= 220) break;
      scope = scope.parentElement;
    }
    if (!scope) return [];

    var out = [], seen = [];
    var cands = scope.querySelectorAll('div, span, input, label');
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (el === labelEl || seen.indexOf(el) >= 0) continue;
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 16 || r.height > 46) continue;
      if (Math.abs((r.top + r.height / 2) - cy) > 14) continue;
      if (r.left < lr.right - 8) continue;
      seen.push(el);
      out.push({ el: el, left: r.left, area: r.width * r.height });
    }
    out.sort(function (a, b) { return (a.left - b.left) || (b.area - a.area); });
    var res = [];
    for (var k = 0; k < out.length && k < 3; k++) res.push(out[k].el);
    return res;
  }

  /** 关掉可能展开的下拉（Esc + 点标题空白处） */
  async function closeDropdowns(d) {
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    } catch (e) {}
    var header = d ? d.querySelector('.el-dialog__title, .el-dialog__header') : null;
    if (header) forceClickOne(header);
    await sleep(600);
  }

  /**
   * 收起下拉的「安全版」：点「素材名称」输入框（相当于点空白处）
   * 不能用 Esc / 点标题 —— 实测那样会把素材目录刚勾的文件夹还原成「全部」
   */
  async function closeDropdownsByClick(d) {
    var inp = findMaterialSearchInput(d);
    if (inp) forceClickOne(inp);
    else {
      var h = d ? d.querySelector('.el-dialog__title') : null;
      if (h) forceClickOne(h);
    }
    await sleep(700);
  }

  /** 读下拉控件当前显示的文本 */
  function readCtlText(ctl) {
    if (!ctl) return '';
    var box = (ctl.closest && ctl.closest('.el-select, .el-cascader')) || ctl;
    return (box.textContent || '').replace(/\s+/g, '');
  }

  /** 控件是不是被清回「全部 / 请选择 / 空」 */
  function isClearedCtl(txt) {
    var t = String(txt || '').replace(/\s+/g, '');
    return !t || t === '全部' || t === '请选择' || t === '不限';
  }

  /**
   * 在整个页面里找「素材目录」树中的那行文件夹（不依赖任何 class）
   * 优先「这一行里有复选框」的（才是树节点），其次才退化成只有文字的元素
   */
  function findFolderRow(folderName) {
    var want = String(folderName || '').replace(/\s+/g, '');
    if (!want) return null;
    var list = document.querySelectorAll('span, div, li, label, p, a');
    var best = null, bestArea = 1e18;     // 带复选框的
    var weak = null, weakArea = 1e18;     // 只有文字的
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (!t) continue;
      if (t !== want && !(t.indexOf(want) === 0 && t.length <= want.length + 8)) continue;
      var r = el.getBoundingClientRect();
      if (r.width > 420 || r.height > 44) continue;
      var a = r.width * r.height;

      var hasBox = false, n = el;
      for (var up = 0; up < 6 && n; up++) {
        if (n.querySelector && n.querySelector('label.el-checkbox, .el-checkbox, input[type="checkbox"]')) { hasBox = true; break; }
        n = n.parentElement;
      }
      if (hasBox) {
        if (a < bestArea) { bestArea = a; best = el; }
      } else if (a < weakArea) {
        weakArea = a; weak = el;
      }
    }
    return best || weak;
  }

  /** 等「素材目录」树里出现目标文件夹（目录树是异步拉的，点开后要给它时间） */
  async function waitFolderRow(folderName, ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) {
      var r = findFolderRow(folderName);
      if (r) return r;
      await sleep(300);
    }
    return null;
  }

  /** 勾选「素材目录」树里的某一行（可重复调用） */
  async function applyFolderRow(rowEl, folderName) {
    if (!rowEl) return false;
    var box = null, row = rowEl;
    for (var up = 0; up < 6 && row; up++) {
      box = row.querySelector ? row.querySelector('label.el-checkbox, .el-checkbox, input[type="checkbox"]') : null;
      if (box) break;
      row = row.parentElement;
    }
    if (!box) {
      forceClickOne(rowEl);
      log('    · 已点「' + folderName + '」（没找到复选框，直接点名字）');
      return true;
    }
    if (isLabelChecked(box)) {
      log('    · 素材目录已经是「' + folderName + '」，不用再勾');
      return true;
    }
    // 找到的是原生 input 时，点它外层 label 更稳（自定义树的点击热区常在 label 上）
    var clickEl = box;
    if (box.tagName === 'INPUT') clickEl = (box.closest && box.closest('label')) || box;
    forceClickOne(clickEl.querySelector('.el-checkbox__inner') || clickEl);
    await sleep(900);
    if (!isLabelChecked(box)) { forceClickOne(clickEl); await sleep(900); }
    log('    · 已勾选素材目录「' + folderName + '」');
    return isLabelChecked(box);
  }

  /**
   * 确保素材目录仍是目标文件夹。
   * 实测：在「素材名称」里输入/点搜索会让筛选区重渲染，素材目录被重置回「全部」，
   * 所以搜索完要再确认一次，必要时重新勾。
   */
  async function materialEnsureFolder(d, folderName) {
    var lbl = findFilterLabel(d, '素材目录');
    if (!lbl) return { ok: false, applied: false };
    var ctls = findRowControls(lbl);
    if (!ctls.length) return { ok: false, applied: false };
    if (!isClearedCtl(readCtlText(ctls[0]))) return { ok: true, applied: false };

    log('    · 素材目录被重置成「全部」了，重新勾选一次');
    for (var i = 0; i < ctls.length && i < 2; i++) {
      forceClickOne(ctls[i]);
      var row = await waitFolderRow(folderName, 5000);
      if (row) {
        await applyFolderRow(row, folderName);
        await sleep(700);
        await closeDropdownsByClick(d);
        return { ok: !isClearedCtl(readCtlText(ctls[i])), applied: true };
      }
      await closeDropdownsByClick(d);
    }
    return { ok: false, applied: true };
  }

  /**
   * 素材库：只在第一个账户做一次的保底操作
   * 右上角「清空」重置上一次筛选（否则素材目录会停在之前选过的总文件夹、
   * 不会自动带上新建的子文件夹）→ 素材目录里勾选 folderName → 收起列表
   */
  async function materialPickFolder(d, folderName) {
    if (!d || !folderName) return false;

    // 1) 右上角「清空」
    var clr = findTopTextButton(d, '清空');
    if (clr) {
      forceClickOne(clr);
      log('    · 已点素材库右上角「清空」（重置上次的筛选）');
      await sleep(1300);
    } else {
      log('    ⚠ 素材库没找到右上角「清空」，继续后续步骤', 'err');
    }

    // 2) 一键定位「素材目录」下拉：按标签定位到它所在那一行，点它右边的控件
    //    只在同一行里找（最多 2 个候选），绝不逐个筛选下拉去试
    var lbl = findFilterLabel(d, '素材目录');
    var rowEl = null;
    var ctl = null;
    if (lbl) {
      var ctls = findRowControls(lbl);
      for (var ci = 0; ci < ctls.length && ci < 2 && !rowEl; ci++) {
        ctl = ctls[ci];
        forceClickOne(ctl);
        rowEl = await waitFolderRow(folderName, 5000);   // 目录树是异步拉的，给它 5 秒
        if (!rowEl) await closeDropdowns(d);
      }
      if (rowEl) log('    · 已打开「素材目录」下拉');
    }

    if (!rowEl) {
      log('    ⚠ 没能定位到素材库「素材目录」（找到标签：' + (lbl ? '是' : '否') +
          '，同排候选：' + (lbl ? findRowControls(lbl).length : 0) + ' 个），跳过选文件夹', 'err');
      return false;
    }

    // 3) 勾选目标文件夹
    await applyFolderRow(rowEl, folderName);
    await sleep(700);

    // 4) 收起下拉：点「素材名称」输入框（相当于点空白处）
    //    不能用 Esc —— 实测 Esc 会把素材目录的选择还原成「全部」
    await closeDropdownsByClick(d);
    var shown = readCtlText(ctl);

    // 兜底：万一还是被还原了，重新打开再勾一次
    if (isClearedCtl(shown)) {
      log('    ⚠ 收起后素材目录被清回「全部」（' + (shown || '空') + '），重新勾选一次', 'err');
      forceClickOne(ctl);
      var again = await waitFolderRow(folderName, 5000);
      if (again) { rowEl = again; await applyFolderRow(rowEl, folderName); }
      await sleep(500);
      await closeDropdownsByClick(d);
      shown = readCtlText(ctl);
    }

    log('    · 素材目录控件当前显示：' + (shown || '?') + '（显示文件夹编码是正常的）');

    // 5) 不再点「收起」：实测点它会把这个筛选区重新初始化，素材目录被清回「全部」。
    //    选完文件夹、收起下拉就够了，直接往下搜索
    return true;
  }

  /**
   * 搜素材；如果库里查不到这部剧（共 0 条），就暂停等用户手动上传，
   * 上传完点「继续」后从**当前账户**接着做，不重跑前面的账户
   */
  async function searchMaterialWithManualWait(md, drama, folderName) {
    var tries = 0;
    while (true) {
      try {
        await materialSearch(md, drama);
        return md;
      } catch (e) {
        var msg = String((e && e.message) || '');
        if (msg.indexOf('没搜到') < 0) throw e;

        tries++;
        log('⚠ 素材库里没有「' + drama + '」的素材（共 0 条，可能漏传了）', 'err');
        log('👉 请把这部剧的素材上传/补传到素材库，上传完点面板「继续」', 'err');
        log('    （会从当前账户接着做，不会重跑前面的账户）', 'err');
        STATE.paused = true;
        updateStatus();
        setStep('⏸ 等你上传「' + drama + '」的素材（上传完点「继续」）');
        expandFromBall();
        await waitFor(function () { return !STATE.paused || STATE.stopped; }, 1800000, 500);
        if (STATE.stopped) throw new Error('__MB_STOPPED__');
        collapseToBall('running');
        log('▶ 已接管完成，继续（重新搜索「' + drama + '」）', 'ok');

        // 用户可能上传后刷新/关掉了素材库，重新取一次
        var md2 = getMaterialDialog();
        if (!md2) throw new Error('素材库已被关闭，请重新点「选择素材」后再继续');
        md = md2;
        await materialEnsureFolder(md, folderName);
        await sleep(700);
        if (tries >= 20) throw new Error('素材库里还是没有「' + drama + '」的素材（已等你 ' + tries + ' 次）');
      }
    }
  }

  async function materialSearch(d, kw) {
    var target = findMaterialSearchInput(d);
    if (!target) throw new Error('没找到素材库搜索框');

    // 只清空「这个」输入框自己的 ×。
    // 之前往上找 3 层，会点在同一行「素材目录」的 × 上，一按就把素材目录重置成「全部」
    if (String(target.value || '').trim()) {
      var clearIcon = null;
      var ir0 = target.getBoundingClientRect();
      var own = (target.closest && target.closest('.el-input, .cl-search-input')) || target.parentElement;
      var icons0 = own ? own.querySelectorAll('i, span') : [];
      for (var ci = 0; ci < icons0.length; ci++) {
        var cls0 = String(icons0[ci].className || '');
        if (cls0.indexOf('clear') < 0 && cls0.indexOf('close') < 0) continue;
        var rr0 = icons0[ci].getBoundingClientRect();
        if (Math.abs((rr0.top + rr0.height / 2) - (ir0.top + ir0.height / 2)) > 12) continue;
        if (rr0.left < ir0.right - 10 || rr0.left > ir0.right + 60) continue;
        clearIcon = icons0[ci]; break;
      }
      if (clearIcon) { forceClickOne(clearIcon); await sleep(600); }
    }
    try { target.readOnly = false; target.removeAttribute('readonly'); } catch (e) {}
    target.value = '';
    target.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);

    var kw2 = String(kw || '').replace(/[：:]/g, '');
    log('    · 素材搜索关键词（已去冒号）：' + kw2);

    await typeChars(target, kw2);
    await sleep(800);
    target.focus();
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    } catch (e) {}
    commitSearch(target);
    await sleep(600);

    var sbtn = null;
    var candidates = d.querySelectorAll('.cl-search-input__submit, .el-input-group__append button, button');
    for (var sb = 0; sb < candidates.length; sb++) {
      var cb2 = candidates[sb];
      if (!visible(cb2) || isDisabled(cb2)) continue;
      if (String(cb2.className || '').indexOf('cl-search-input__submit') >= 0) { sbtn = cb2; break; }
    }
    if (!sbtn) {
      var ir = target.getBoundingClientRect();
      var bestD = 1e9;
      for (var sb2 = 0; sb2 < candidates.length; sb2++) {
        var b2 = candidates[sb2];
        if (!visible(b2) || isDisabled(b2)) continue;
        var br2 = b2.getBoundingClientRect();
        var dy2 = Math.abs((br2.top + br2.height / 2) - (ir.top + ir.height / 2));
        var dx2 = br2.left - ir.right;
        if (dy2 > 30 || dx2 < -12 || dx2 > 90) continue;
        if (dx2 < bestD) { bestD = dx2; sbtn = b2; }
      }
    }
    if (sbtn) { forceClickOne(sbtn); }
    else { commitSearch(target); log('    ⚠ 没找到搜索按钮，改用 change 事件', 'err'); }
    await sleep(4000);

    var pageTxt = (d.textContent || '').replace(/\s+/g, ' ');
    var mCnt = pageTxt.match(/共\s*(\d+)\s*条/);
    if (mCnt) {
      log('    · 搜索后共 ' + mCnt[1] + ' 条素材');
      if (parseInt(mCnt[1], 10) === 0) throw new Error('素材库里没搜到「' + kw2 + '」的素材');
    }
  }

  /** 素材库：前 2 页全选 */
  async function materialSelectFirstTwoPages(d) {
    var findSelectAll = function () {
      var list = d.querySelectorAll('label.el-checkbox, label, span, button');
      var best = null, bestTop = -1e9;
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!visible(el)) continue;
        if ((el.textContent || '').replace(/\s+/g, '').trim() !== '全选') continue;
        var r = el.getBoundingClientRect();
        if (r.width > 90) continue;
        if (r.top > bestTop) { bestTop = r.top; best = el; }
      }
      return best;
    };
    var doSelectAll = async function (label) {
      if (!label) return false;
      var box = label.closest ? label.closest('label.el-checkbox') : null;
      var before = readSelectedCount(d);
      forceClickOne(box || label);
      await sleep(1800);
      var after = readSelectedCount(d);
      if (before === after) {
        var inner = (box || label).querySelector('.el-checkbox__inner, .el-checkbox__input');
        if (inner) { forceClickOne(inner); await sleep(1800); after = readSelectedCount(d); }
      }
      log('    · 全选后已选素材：' + after);
      return after !== before || after > 0;
    };

    var lbl = findSelectAll();
    if (!lbl) { log('    ⚠ 没找到左下角「全选」', 'err'); return; }
    var ok1 = await doSelectAll(lbl);
    log(ok1 ? '    ✓ 第 1 页已全选' : '    ⚠ 第 1 页全选可能没生效', ok1 ? 'ok' : 'err');

    var page2 = null;
    var lis = d.querySelectorAll('.el-pager li, .el-pagination li, .el-pager span, .el-pagination span');
    for (var p = 0; p < lis.length; p++) {
      if (!visible(lis[p])) continue;
      if ((lis[p].textContent || '').trim() === '2') { page2 = lis[p]; break; }
    }
    if (page2) {
      forceClickOne(page2);
      log('    ✓ 已翻到第 2 页', 'ok');
      await sleep(2800);
      var lbl2 = findSelectAll();
      var ok2 = await doSelectAll(lbl2);
      log(ok2 ? '    ✓ 第 2 页已全选' : '    ⚠ 第 2 页全选可能没生效', ok2 ? 'ok' : 'err');
    } else {
      log('    ⚠ 没找到第 2 页（可能只有一页）', 'info');
    }
    log('    最终已选素材数：' + readSelectedCount(d), 'ok');
  }

  /** 素材库：提交 */
  async function materialSubmit(d) {
    var btn = findDialogButton(d, ['提交', '确定']);
    if (!btn) throw new Error('素材库没有可点的「提交」');
    forceClickOne(btn);
    var closed = await waitFor(function () { return !getMaterialDialog(); }, 10000, 350);
    if (!closed) throw new Error('点了「提交」但素材库没关闭');
    await sleep(1200);
  }

  /** 素材抽屉：乱序 times 次（等素材化配置完成再点） */
  async function creativeShuffle(dr, times) {
    var isBusy = function () {
      var t = (dr.textContent || '');
      if (t.indexOf('素材化配置中') >= 0) return true;
      if (t.indexOf('资源加载中') >= 0) return true;
      var lds = dr.querySelectorAll('.el-loading-mask, .is-loading, .el-loading-spinner');
      for (var i = 0; i < lds.length; i++) if (visible(lds[i])) return true;
      return false;
    };
    if (isBusy()) log('    · 素材还在配置中，等待校验完成…');
    var done = await waitFor(function () { return !isBusy(); }, 40000, 500);
    log('    · 素材配置' + (done ? '已完成' : '等待超时（继续尝试）'));
    await sleep(1500);

    var el = null;
    for (var w = 0; w < 20; w++) {
      var list = dr.querySelectorAll('button, [role="button"], span, div, i');
      for (var i2 = 0; i2 < list.length; i2++) {
        if (!visible(list[i2]) || isDisabled(list[i2])) continue;
        if ((list[i2].textContent || '').replace(/\s+/g, '') === '乱序') { el = list[i2]; break; }
      }
      if (el) break;
      await sleep(500);
    }
    if (!el) throw new Error('素材抽屉里没找到可点的「乱序」');

    for (var k = 0; k < times; k++) {
      forceClickOne(el);
      log('    · 第 ' + (k + 1) + ' 次乱序');
      await sleep(1500);
    }
    await sleep(800);
  }

  /** 落地页抽屉里：删掉当前账户已选的落地页（每部剧只能选一个，旧的占着新的就灰） */
  async function clearLandingSelection(dr, inp) {
    var selCnt = function () {
      var nodes = dr.querySelectorAll('span, div');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!visible(el)) continue;
        var t = (el.textContent || '').replace(/\s+/g, '');
        if (!t || t.length > 12) continue;
        var m = t.match(/^已选[：:]?(\d+)/);
        if (m) return parseInt(m[1], 10);
      }
      return -1;
    };

    var firstChecked = function () {
      var labels = dr.querySelectorAll('label.el-checkbox');
      for (var i = 0; i < labels.length; i++) {
        if (!visible(labels[i])) continue;
        if (!isLabelChecked(labels[i])) continue;
        return labels[i];
      }
      return null;
    };

    // 先把搜索清掉，露出列表，才能看到并取消当前选中的那条
    if (inp) {
      try {
        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '');
      } catch (e) { try { inp.value = ''; } catch (e2) {} }
      try {
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e3) {}
      await sleep(1200);
    }

    // 1) 列表里能看到勾选行 → 直接点掉（只影响当前账户）
    for (var round = 0; round < 2; round++) {
      var row = firstChecked();
      if (!row) break;
      forceClickOne(row);
      await sleep(900);
      if (isLabelChecked(row)) {
        var inner = row.querySelector('.el-checkbox__inner');
        if (inner) { forceClickOne(inner); await sleep(900); }
      }
      if (isLabelChecked(row)) break;
    }
    if (!firstChecked()) {
      var c1 = selCnt();
      if (c1 <= 0) return true;
    }

    // 2) 看不到勾选行但「已选」还有 → 点「已选 N」旁边的「清空」
    var clr = findClearInDialog(dr);
    if (clr) {
      forceClickOne(clr);
      await sleep(1000);
      var conf = findClearConfirm();
      if (conf) { forceClickOne(conf); await sleep(900); }
      await sleep(600);
    }
    var c2 = selCnt();
    return c2 <= 0;
  }

  /**
   * 落地页列表某一行的「属于哪个账户」打分
   *  3 = 行里写的就是当前账户
   *  2 = 不限
   *  1 = 行里没写账户号（按「当前账户列表里就是它」处理）
   * -1 = 明确写着别的账户（同名落地页挂到本账户会挂错，不能要）
   */
  function landingRowScore(flat, acc, allAccs) {
    if (!acc) return flat.indexOf('不限') >= 0 ? 2 : 1;
    if (flat.indexOf(acc) >= 0) return 3;
    if (allAccs) {
      for (var i = 0; i < allAccs.length; i++) {
        var oa = String(allAccs[i] || '');
        if (!oa || oa === acc) continue;
        if (flat.indexOf(oa) >= 0) return -1;
      }
    }
    if (flat.indexOf('不限') >= 0) return 2;
    return 1;
  }

  /** 落地页列表里按关键词（短剧名）搜索并勾选（每账户只能一个，旧的先删） */
  async function pickLandingFor(dr, keyword, acc, allAccs) {
    var inp = null;
    var ins = dr.querySelectorAll('input');
    for (var j = 0; j < ins.length; j++) {
      if (!visible(ins[j])) continue;
      var ph = ins[j].placeholder || '';
      if (ph.indexOf('关键词') >= 0 || ph.indexOf('搜索') >= 0) { inp = ins[j]; break; }
    }
    if (!inp) {
      for (var j2 = 0; j2 < ins.length; j2++) {
        if (!visible(ins[j2])) continue;
        if (ins[j2].type === 'checkbox' || ins[j2].type === 'radio') continue;
        if (ins[j2].readOnly) continue;
        inp = ins[j2]; break;
      }
    }
    if (!inp) throw new Error('没找到落地页搜索框');

    var key = normText(keyword);

    var search = async function () {
      try {
        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '');
      } catch (e) { try { inp.value = ''; } catch (e2) {} }
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
      await sleep(300);
      forceClickOne(inp);
      await sleep(300);
      await typeChars(inp, keyword);
      await sleep(700);
      try {
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      } catch (e) {}
      commitSearch(inp);
      await sleep(3000);
    };

    var currentSel = function () {
      var cks = dr.querySelectorAll('label.el-checkbox');
      for (var i = 0; i < cks.length; i++) {
        if (!visible(cks[i])) continue;
        if (!isLabelChecked(cks[i])) continue;
        return (cks[i].textContent || '').replace(/\s+/g, ' ').trim();
      }
      return '';
    };

    var collect = function () {
      var rows = dr.querySelectorAll('.list-checkbox-container label.el-checkbox, label.el-checkbox');
      var hit = 0;
      var best = null, bestScore = -1;
      for (var k = 0; k < rows.length; k++) {
        var row = rows[k];
        if (!visible(row)) continue;
        var raw = row.textContent || '';
        if (normText(raw).indexOf(key) < 0) continue;
        hit++;
        if (String(row.className || '').indexOf('is-disabled') >= 0) continue;
        // 同名落地页可能分属不同账户：优先挑「媒体账户就是当前账户」的那条，
        // 其次是「不限」，明确写着别的账户的一律不要（否则会挂错账户的落地页）。
        // 注意：很多列表行里压根不带账户号，这种不能当成「别人的」排除掉。
        var flat = raw.replace(/\s+/g, '');
        var score = landingRowScore(flat, acc, allAccs);
        if (score > bestScore) { bestScore = score; best = row; }
      }
      return { pick: bestScore >= 0 ? best : null, hit: hit, score: bestScore };
    };

    // 1) 先清空搜索，露出完整列表，看当前挂的是不是已经是目标剧
    try {
      var setter0 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter0.call(inp, '');
    } catch (e) { try { inp.value = ''; } catch (e2) {} }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500);

    var cur = currentSel();
    if (cur && normText(cur).indexOf(key) >= 0) {
      log('    · 该账户落地页已是目标剧：' + cur.slice(0, 40), 'ok');
      return true;
    }

    // 2) 旧落地页占着位置 → 先删掉，新剧的才会从灰色变可选
    if (cur) {
      await clearLandingSelection(dr, inp);
      log('    · 已删掉该账户原有落地页：' + cur.slice(0, 32), 'ok');
      await sleep(1200);
    }

    // 3) 搜索并勾选
    await search();
    var r = collect();
    if (!r.pick && r.hit > 0) {
      // 删过一次还是灰的，再清一次再试
      await clearLandingSelection(dr, inp);
      await sleep(1200);
      await search();
      r = collect();
    }

    if (!r.pick) {
      if (r.hit === 0) throw new Error('落地页列表里没有「' + keyword + '」');
      if (r.score < 0) {
        log('    ⚠ 同名的落地页都属于其它账户，当前账户没有可用的「' + keyword + '」，请手动处理', 'err');
      } else {
        log('    ⚠ 「' + keyword + '」的落地页仍全部不可选（已使用），请手动处理', 'err');
      }
      return true;
    }
    await clickLabelCheckbox(r.pick);
    log('    ✓ 已选中落地页：' + (r.pick.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), 'ok');
    await sleep(800);

    // 勾完回读：选中的这一行必须还是这部剧（且不是别的账户的）
    var after = currentSel();
    if (after && normText(after).indexOf(key) < 0) {
      log('    ⚠ 选中的落地页看起来不是目标剧：' + after.slice(0, 40), 'err');
    }
    return true;
  }

  /* -------------------- 23 步 -------------------- */

  var STEPS = [

    // 1. 改账户
    { label: '改账户 - 点「更改」', fn: async function (ctx) {
        var dlg = getVisibleDialog();
        if (dlg) { log('⏭ 账户弹窗已打开，跳过'); return; }

        // 先诊断一下页面上到底有几个"更改"
        var all = document.querySelectorAll('button,span,div,a,label');
        var cand = [];
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (!visible(el)) continue;
          var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t === '更改' && !isDisabled(el)) {
            var r = el.getBoundingClientRect();
            cand.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 40),
                        x: Math.round(r.x), y: Math.round(r.y) });
          }
        }
        log('  · 页面上「更改」候选: ' + cand.length + ' 个 — ' +
            (cand.length ? JSON.stringify(cand.slice(0, 5)) : '无'));

        // 最多 3 次：每次都 forceClickOne
        var ok = false;
        for (var attempt = 0; attempt < 3; attempt++) {
          var el = findAndClick('更改', { exact: true, prefer: 'top' });
          if (!el) { log('  ✗ 第 ' + (attempt + 1) + ' 次：没找到元素'); await sleep(600); continue; }

          // 等「选择媒体账户」这个弹窗出现（最多 5 秒）
          var appeared = await waitFor(function () { return !!getAccountDialog(); }, 5000, 300);
          if (appeared) { ok = true; break; }
          log('  · 第 ' + (attempt + 1) + ' 次点击后账户弹窗没出来，再试试...');
          await sleep(600);
        }
        if (!ok) throw new Error('连续 3 次点「更改」都没弹出账户选择窗口');
        log('  ✓ 账户弹窗已出现', 'ok');
    }},

    // 2. 清空已选 + 清空（文档：两个都要点；这两个是文字链接不是 button，必须全标签找）
    { label: '清空已选 + 清空', fn: async function (ctx) {
        var dlg = getAccountDialog();
        if (!dlg) throw new Error('账户弹窗不见了');

        var clickAny = function (text, maxW) {
          var list = dlg.querySelectorAll('button, span, a, div, i, label, b');
          var best = null, bestW = 1e9;
          for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (!visible(el) || isDisabled(el)) continue;
            var t = (el.textContent || '').replace(/\s+/g, '').trim();
            if (t !== text) continue;
            var r = el.getBoundingClientRect();
            if (r.width < 10 || r.height < 8) continue;
            if (r.width > maxW) continue;
            if (r.width < bestW) { bestW = r.width; best = el; }
          }
          if (best) { forceClickOne(best); return true; }
          return false;
        };

        var readSel = function () {
          var t = (dlg.textContent || '').replace(/\s+/g, ' ');
          var m = t.match(/已选\s*(\d+)/);   // 页面文案是「已选 2 /50 个账户」
          return m ? parseInt(m[1], 10) : -1;
        };

        log('  · 清空前已选账户数：' + readSel());

        if (clickAny('清空已选', 220)) log('  ✓ 已点「清空已选」', 'ok');
        else log('  ⚠ 没找到「清空已选」', 'info');
        await sleep(1000);

        if (clickAny('清空', 120)) log('  ✓ 已点「清空」', 'ok');
        else log('  ⚠ 没找到「清空」', 'info');
        await sleep(1200);

        var left = readSel();
        log('  · 清空后已选账户数：' + left);

        // 还有残留就再点一次
        if (left > 0) {
          if (clickAny('清空', 120)) { await sleep(1200); left = readSel(); }
          log('  · 二次清空后已选账户数：' + left, left > 0 ? 'err' : 'ok');
        }
    }},

    // 3-4. 逐个搜索 + 勾选
    // 重点：勾完必须回读弹窗里的「已选 N」——虚拟列表会复用行，
    // 只看 checkbox.checked 会出现「以为勾了 4 个，实际只有 1 个」。
    { label: '搜索并勾选账户', fn: async function (ctx) {
        var ids = ctx.accounts || [];

        var selCount = function () {
          var d = getAccountDialog();
          if (!d) return -1;
          var t = (d.textContent || '').replace(/\s+/g, ' ');
          var m = t.match(/已选\s*(\d+)/);   // 页面文案「已选 2 /50 个账户」
          return m ? parseInt(m[1], 10) : -1;
        };

        // 搜索一个账户，返回表格里含该 ID 的可见行；搜不到返回 null
        var searchAccount = async function (id) {
          var dlg = getAccountDialog();
          if (!dlg) throw new Error('账户弹窗不见了（' + id + '）');
          var input = findSearchInput(dlg);
          if (!input) throw new Error('没找到账户搜索框');

          // 先彻底清空搜索框（避免上一个 ID 残留影响这次搜索）
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(250);

          setInputValue(input, id);
          await sleep(400);

          // 点搜索按钮（三重保险）
          // 保险 1：搜索框右边的小 BUTTON（放大镜图标，textContent 为空）
          var clickedSearch = false;
          var srR = input.getBoundingClientRect();
          var btns = dlg.querySelectorAll('button');
          for (var bi = 0; bi < btns.length; bi++) {
            var b = btns[bi];
            if (!visible(b) || isDisabled(b)) continue;
            var br = b.getBoundingClientRect();
            var dx = br.left - srR.right;
            var dy = Math.abs((br.top + br.height / 2) - (srR.top + srR.height / 2));
            if (dx >= -60 && dx <= 120 && dy < 40 && br.width >= 16 && br.width <= 60 && br.height >= 16 && br.height <= 50) {
              forceClickOne(b);
              clickedSearch = true;
              break;
            }
          }
          // 保险 2：按文字找
          if (!clickedSearch && findAndClick('搜索', { exact: false, inDialog: true, tags: 'button,span,a,i' })) {
            clickedSearch = true;
          }
          // 保险 3：Enter 兜底
          if (!clickedSearch) {
            try {
              input.focus();
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            } catch (e) {}
          }

          await sleep(1800);

          var rows = dlg.querySelectorAll('tbody tr, tr');
          var hit = null;
          var rowTexts = [];
          for (var r = 0; r < rows.length; r++) {
            if (!visible(rows[r])) continue;
            var txt = (rows[r].textContent || '').replace(/\s+/g, ' ');
            if (!txt) continue;
            if (rowTexts.length < 3) rowTexts.push(txt.slice(0, 60));
            if (txt.indexOf(id) >= 0 && !hit) hit = rows[r];
          }
          log('    · 搜 ' + id + ' → 表格首几行：' + (rowTexts.length ? rowTexts.join(' | ') : '(空)'));
          return hit;
        };

        var picked = [];
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          log('  · 搜索账户 ' + id + '（第 ' + (i + 1) + '/' + ids.length + ' 个）');

          var row = await searchAccount(id);
          if (!row) {
            log('  ⚠ 搜「' + id + '」后表格里没有这行 —— 跳过（可能不在权限内）', 'err');
            continue;
          }

          var before = selCount();
          var ok = false;
          for (var t = 0; t < 2 && !ok; t++) {
            ok = checkRow(row);
            await sleep(650);
            var after = selCount();
            // 用「已选 N」做权威判定：数量没涨就是没真勾上
            if (ok && before >= 0 && after >= 0 && after <= before) {
              ok = false;
              log('    · 第 ' + (t + 1) + ' 次勾选后「已选」没增加（' + before + '→' + after + '），重试');
              row = await searchAccount(id);
              if (!row) break;
            }
          }
          if (!ok) { log('  ✗ ' + id + ' 勾选失败', 'err'); continue; }

          picked.push(id);
          log('    ✓ 已勾选 ' + id + '（弹窗已选 ' + selCount() + '）', 'ok');
          await sleep(400);
        }

        if (picked.length === 0) {
          throw new Error('所有账户都搜不到或勾不上（已尝试：' + ids.join(', ') + '），请检查账户 ID 是否正确或是否在你的权限范围内');
        }

        // 复核：已选数量必须至少等于 picked 数量，不足就补勾一轮
        var expect = picked.length;
        var now = selCount();
        if (now >= 0 && now < expect) {
          log('  ⚠ 复核发现只选中 ' + now + ' 个（应为 ' + expect + ' 个），补勾一轮', 'err');
          for (var k = 0; k < picked.length; k++) {
            var row2 = await searchAccount(picked[k]);
            if (!row2) continue;
            var b2 = selCount();
            checkRow(row2);
            await sleep(700);
            var a2 = selCount();
            if (b2 >= 0 && a2 >= 0 && a2 <= b2) log('  ✗ 补勾 ' + picked[k] + ' 仍失败（' + b2 + '→' + a2 + '）', 'err');
          }
          now = selCount();
        }

        log('✓ 本轮共勾选：' + picked.join(', ') + '（' + picked.length + '/' + ids.length + '，弹窗已选 ' + now + '）', 'ok');
        if (now >= 0 && now < expect) {
          throw new Error('账户只选中 ' + now + ' 个，少于预期 ' + expect + ' 个（' + picked.join(', ') + '）');
        }
        await sleep(400);
    }},

    // 5. 账户弹窗确定（只认「选择媒体账户」这个弹窗，等它真的消失才算成功）
    { label: '账户弹窗 - 确定', fn: async function (ctx) {
        var dlg = getAccountDialog();
        if (!dlg) { log('账户弹窗已经不在了，跳过', 'ok'); return; }

        // 诊断日志
        var btns = dlg.querySelectorAll('button');
        for (var bi = 0; bi < btns.length; bi++) {
          var t = (btns[bi].textContent || '').trim();
          if (t === '确定' || t === '取消') {
            log('    · 弹窗「' + t + '」 disabled=' + btns[bi].disabled);
          }
        }

        for (var attempt = 0; attempt < 3; attempt++) {
          var btn = findDialogConfirm(getAccountDialog() || dlg);
          if (!btn) {
            log('  · 第 ' + (attempt + 1) + ' 次：没找到可点的「确定」');
            await sleep(800);
            if (!getAccountDialog()) break;
            continue;
          }
          var br = btn.getBoundingClientRect();
          log('  · 点「确定」(' + Math.round(br.left + br.width / 2) + ',' +
              Math.round(br.top + br.height / 2) + ')');
          forceClickOne(btn);

          // 等账户弹窗消失（最多 6 秒）
          var gone = await waitFor(function () { return !getAccountDialog(); }, 6000, 300);
          if (gone) break;
          log('  · 账户弹窗还没关，重试第 ' + (attempt + 2) + ' 次');
          await sleep(600);
        }

        if (getAccountDialog()) {
          throw new Error('点了 3 次「确定」，账户选择弹窗仍然没关（可能页面在等待校验，请手动看下弹窗里的红字提示）');
        }
        log('✓ 账户弹窗已关闭，账户已切换', 'ok');
        await sleep(1500);
    }},

    // 6. 复用模板（会弹「复用配置：重新配置 / 复用」，必须点「复用」）
    { label: '复用模板', fn: async function (ctx) {
        if (!ctx.copyTemplate) { log('跳过（未勾选复用模板）'); return; }
        var el = findAndClick('复用', { exact: true }) ||
                 findAndClick('复用模板', { exact: false });
        if (!el) {
          log('⚠ 页面上没找到「复用」按钮，跳过这一步', 'err');
          return;
        }
        log('✓ 已点「复用」，等待复用配置弹窗', 'ok');

        var handled = await confirmReuseDialog();
        if (!handled) {
          // 也许是普通的 取消/确认 弹窗
          handled = await dismissConfirmIfAny(null, 1200);
        }
        if (handled) log('✓ 复用配置已确认（模板已应用）', 'ok');
        else log('⚠ 没等到复用配置弹窗（可能已自动应用）', 'info');

        // 等页面把模板套上去
        await waitFor(function () { return !getVisibleDialog(); }, 5000, 300);
        await sleep(2000);
    }},

    // 7. 广告信息 - 编辑（打开右侧「广告基本信息」抽屉 .cl-drawer）
    { label: '广告信息 - 编辑', fn: async function (ctx) {
        if (getInfoDrawer()) { log('  · 抽屉已经打开，跳过点击', 'info'); return; }

        var el = clickColumnAction('广告信息', '编辑');
        if (!el) {
          log('  · 「广告信息」列的编辑没找到，退回按文字找', 'info');
          el = await findAndClickWithRetry('编辑', { exact: true }, 3);
        }
        if (!el) throw new Error('没找到「编辑」按钮');

        var opened = await waitFor(function () { return !!getInfoDrawer(); }, 8000, 300);
        if (!opened) throw new Error('点了「编辑」但右侧抽屉没出现');
        log('  ✓ 广告基本信息抽屉已打开', 'ok');
        await sleep(600);
    }},

    // 8. 推广产品（按账户）：多账户切「按账户分配」，每个账户加自己那部剧，最后一起确定
    { label: '推广产品（按账户）', fn: async function (ctx) {
        var dramas = ctxDramas(ctx);
        var dr = getInfoDrawer();
        if (!dr) throw new Error('广告基本信息抽屉不见了');

        var d = getProductDialog();
        if (!d) {
          // 入口有两种：已选过产品时是「修改已选产品」；复用模板后产品是空的，是「推广产品」那行的「添加」/「选择产品」
          var findProductEntry = function () {
            var all = dr.querySelectorAll('button, span, a');
            var i, el, t;
            var want = ['修改已选产品', '选择产品', '修改产品'];
            for (i = 0; i < all.length; i++) {
              el = all[i];
              if (!visible(el) || isDisabled(el)) continue;
              t = (el.textContent || '').replace(/\s+/g, '').trim();
              if (want.indexOf(t) >= 0) return el;
            }
            // 找「推广产品」标签所在那一行里的「添加」
            var labels = dr.querySelectorAll('label, span, div');
            for (i = 0; i < labels.length; i++) {
              var lb = labels[i];
              if (!visible(lb)) continue;
              t = (lb.textContent || '').replace(/\s+/g, '').trim();
              if (t !== '推广产品') continue;
              var rr = lb.getBoundingClientRect();
              if (rr.width > 140) continue;
              var p = lb.parentElement;
              for (var up = 0; up < 5 && p; up++) {
                var rowTxt = (p.textContent || '').replace(/\s+/g, '');
                if (rowTxt.indexOf('推广产品') >= 0 &&
                    (rowTxt.indexOf('添加') >= 0 || rowTxt.indexOf('选择产品') >= 0)) {
                  var btns = p.querySelectorAll('button, span, a');
                  for (var b = 0; b < btns.length; b++) {
                    if (!visible(btns[b]) || isDisabled(btns[b])) continue;
                    var bt = (btns[b].textContent || '').replace(/\s+/g, '').trim();
                    if (bt === '添加' || bt === '选择产品') return btns[b];
                  }
                }
                p = p.parentElement;
              }
            }
            return null;
          };

          var btn = findProductEntry();
          if (!btn) throw new Error('抽屉里没找到「修改已选产品 / 添加」入口');
          forceClickOne(btn);
          var opened = await waitFor(function () { return !!getProductDialog(); }, 8000, 300);
          if (!opened) {
            await sleep(600);
            // 换一个入口再试一次
            var btn2 = findProductEntry();
            if (btn2 && btn2 !== btn) { forceClickOne(btn2); opened = await waitFor(function () { return !!getProductDialog(); }, 8000, 300); }
          }
          if (!opened) throw new Error('点了产品入口但没弹出「选择推广产品」');
          d = getProductDialog();
          log('  ✓ 选择推广产品弹窗已打开', 'ok');
          await sleep(800);
        }

        // 「已选：1」——只读当前可见卡片里的那个（弹窗里 4 个账户各有一张卡片）
        var prodSel = function () {
          var d2 = getProductDialog() || d;
          if (!d2) return -1;
          var nodes = d2.querySelectorAll('span, div, p');
          for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (!visible(el)) continue;
            var t = (el.textContent || '').replace(/\s+/g, '');
            if (!t || t.length > 12) continue;
            var m = t.match(/^已选[：:]?(\d+)/);
            if (m) return parseInt(m[1], 10);
          }
          // 兜底：整段文本里找
          var m2 = (d2.textContent || '').replace(/\s+/g, ' ').match(/已选[：:\s]*(\d+)/);
          return m2 ? parseInt(m2[1], 10) : -1;
        };

        // 清掉当前账户已选的产品：先点「清空」，不行再点 ×，最多重试 3 轮
        var clearProductSel = async function (d2) {
          for (var attempt = 0; attempt < 3; attempt++) {
            if (prodSel() === 0) return true;
            d2 = getProductDialog() || d2;

            // 1) 「已选 N」旁边的「清空」（按锚点找，避免点到别的账户的）
            var clr = findClearInDialog(d2);
            if (clr) {
              forceClickOne(clr);
              await sleep(800);
              if (prodSel() > 0 && clr.parentElement) { forceClickOne(clr.parentElement); await sleep(800); }
              var conf = findClearConfirm();
              if (conf) { forceClickOne(conf); await sleep(900); }
              if (prodSel() === 0) return true;
            }

            // 2) 还有残留就逐个点 ×
            for (var round = 0; round < 6; round++) {
              if (prodSel() === 0) return true;
              var dr2 = d2.getBoundingClientRect();
              var dels = d2.querySelectorAll('i.mg-icon-close, .mg-icon-close, .el-tag__close, .el-icon-close');
              var hit = null;
              for (var k = 0; k < dels.length; k++) {
                if (!visible(dels[k])) continue;
                var r = dels[k].getBoundingClientRect();
                if (r.top < dr2.top + 70) continue;      // 跳过弹窗标题栏的 ×
                if (r.width > 30 || r.height > 30) continue;
                hit = dels[k]; break;
              }
              if (!hit) break;
              forceClickOne(hit);
              await sleep(700);
            }
            if (prodSel() === 0) return true;
            await sleep(600);
          }
          return prodSel() === 0;
        };

        // 按面板选的执行方式走：
        //   统一模式 → 「全部相同」，只加一次、不切账户
        //   分账户（多账户）→ 「分配到账户」，即使各账户填的是同一部剧也逐个账户选
        var uni = ctxUnified(ctx);
        if (ctx.accounts.length > 1) {
          if (uni) {
            var okSame = await activateChoice(d, ['全部相同']);
            if (!okSame) {
              throw new Error('「选择推广产品」里没找到「全部相同」，请手动切过去后点面板「继续」');
            }
            log('  · 分配规则：全部相同（统一模式，不切账户）', 'ok');
            await confirmTipIfAny();
            await sleep(1500);
          } else {
            var sameCard = findRuleCard(d, '全部相同');
            var wasSame = !!(sameCard && isChoiceActive(sameCard));
            var okRule = await activateChoice(d, ['分配到账户', '按账户分配']);
            if (!okRule) {
              throw new Error('「选择推广产品」里没找到「分配到账户」，请手动切过去后点面板「继续」');
            }
            log('  · 分配规则：' + (wasSame ? '原来是「全部相同」，已切换到「分配到账户」' : '分配到账户'), 'ok');
            await confirmTipIfAny();      // 切换规则会弹「会重置所有已选产品，是否继续？」
            await sleep(1500);

            // 切规则后平台要重渲染左侧账户列表，等它出来再开始切账户（否则会误报“切不到账户”）
            if (wasSame) {
              var listReady = await waitFor(function () {
                var dd = getProductDialog();
                if (!dd) return false;
                if (isDataSourceSelectMode(dd)) return true;
                for (var qi = 0; qi < ctx.accounts.length; qi++) {
                  if (findAccountNode(dd, ctx.accounts[qi]) || findAccountNode(document, ctx.accounts[qi])) return true;
                }
                return false;
              }, 15000, 400);
              if (!listReady) {
                // 还没出来就点一次「刷新」，再等一轮
                var rfBtn = findDialogButton(getProductDialog() || d, ['刷新']);
                if (rfBtn) {
                  forceClickOne(rfBtn);
                  log('  · 切规则后账户列表没出来，点了「刷新」再等', 'err');
                  await sleep(2500);
                  listReady = await waitFor(function () {
                    var dd2 = getProductDialog();
                    if (!dd2) return false;
                    if (isDataSourceSelectMode(dd2)) return true;
                    for (var qj = 0; qj < ctx.accounts.length; qj++) {
                      if (findAccountNode(dd2, ctx.accounts[qj]) || findAccountNode(document, ctx.accounts[qj])) return true;
                    }
                    return false;
                  }, 12000, 400);
                }
              }
              log(listReady ? '  · 账户列表已刷新，开始逐个账户选' : '  ⚠ 切规则后账户列表还没出来', listReady ? 'ok' : 'err');
            }
          }
        }
        var targets = uni ? [ctx.accounts[0]] : ctx.accounts;

        for (var ai = 0; ai < targets.length; ai++) {
          var acc = targets[ai];
          var drama = dramas[ai];
          if (uni) {
            log('  【统一】' + targets.join(' / ') + ' 共用 → 「' + drama + '」');
          } else {
            log('  【' + (ai + 1) + '/' + targets.length + '】账户 ' + acc + ' → 「' + drama + '」');
          }

          d = getProductDialog();
          if (!d) throw new Error('「选择推广产品」弹窗不见了');

          if (!uni && ctx.accounts.length > 1) {
            var okAcc = await clickAccountRow(d, acc);
            if (!okAcc) okAcc = await clickAccountRow(document, acc);   // 列表可能被渲染到弹窗节点之外
            if (!okAcc) {
              log('    · 账户 ' + acc + ' 还没出现，等列表刷新后再试');
              for (var ra = 0; ra < 10 && !okAcc; ra++) {
                await sleep(700);
                d = getProductDialog() || d;
                okAcc = await clickAccountRow(d, acc);
                if (!okAcc) okAcc = await clickAccountRow(document, acc);
              }
            }
            if (!okAcc) {
              var ddF = getProductDialog();
              var cntF = 0;
              if (ddF) {
                if (isDataSourceSelectMode(ddF)) {
                  // 数据源下拉场景：账户都在下拉里，认不全 DOM 但下拉里肯定有
                  cntF = ctx.accounts.length;
                } else {
                  for (var qf = 0; qf < ctx.accounts.length; qf++) {
                    if (findAccountNode(ddF, ctx.accounts[qf])) cntF++;
                  }
                }
              }
              log('⚠ 推广产品弹窗切不到账户 ' + acc + '（' + (isDataSourceSelectMode(ddF) ? '数据源下拉模式' : '列表里认出 ' + cntF + '/' + ctx.accounts.length) + '）', 'err');
              log('👉 请手动切到账户 ' + acc + ' 后点面板「继续」', 'err');
              STATE.paused = true;
              updateStatus();
              setStep('⏸ 等你手动切到账户 ' + acc + '（切好点「继续」）');
              expandFromBall();
              await waitFor(function () { return !STATE.paused || STATE.stopped; }, 900000, 500);
              if (STATE.stopped) throw new Error('__MB_STOPPED__');
              collapseToBall('running');
              log('▶ 已接管完成，继续', 'ok');
              d = getProductDialog() || d;
            }
            log('    · 已切到账户 ' + acc);
            d = getProductDialog() || d;
          }

          var cleared = await clearProductSel(d);
          var leftCnt = prodSel();
          if (!cleared || leftCnt > 0) {   // 再补一轮：重新点账户 → 清空
            if (!uni && ctx.accounts.length > 1) {
              await clickAccountRow(getProductDialog() || d, acc);
              d = getProductDialog() || d;
            }
            cleared = await clearProductSel(d);
            leftCnt = prodSel();
          }
          log('    · 当前已选：' + leftCnt, leftCnt === 0 ? 'ok' : 'err');
          if (leftCnt > 0) {
            throw new Error('账户 ' + acc + ' 的旧产品没清掉（已选 ' + leftCnt + ' 个），请手动清空后点「继续」');
          }

          // 商品库（多账户共用；显示已经是目标商品库就不再改，避免重输）
          var libOk = function () {
            var d3 = getProductDialog() || d;
            if (!d3) return false;
            var inp = getLibraryInput(d3);
            if (inp) {
              if ((inp.value || '').indexOf(ctx.library) >= 0) return true;
              var host = inp.closest ? inp.closest('.el-select') : null;
              if (host && (host.textContent || '').indexOf(ctx.library) >= 0) return true;
            }
            // 兜底：弹窗里任一可见下拉的显示文字就是目标商品库，也算已经设置正确
            var sels = d3.querySelectorAll('.el-select');
            for (var si = 0; si < sels.length; si++) {
              if (!visible(sels[si])) continue;
              if ((sels[si].textContent || '').replace(/\s+/g, '').indexOf(ctx.library) >= 0) return true;
            }
            return false;
          };

          // 切账户后组件会重渲染，值可能短暂是空的 → 先等它稳定，再决定要不要切
          var libReady = libOk();
          for (var lw = 0; lw < 5 && !libReady; lw++) {
            await sleep(400);
            libReady = libOk();
          }

          if (!libReady) {
            var inpLib = getLibraryInput(d) || getLibraryInput(getProductDialog() || d);
            if (!inpLib) throw new Error('没找到「商品库」下拉框');
            await pickSelectOption(inpLib, ctx.library);
            await sleep(1500);
            if (!libOk()) {          // 再补一次
              await sleep(1000);
              var inpLib2 = getLibraryInput(getProductDialog() || d);
              if (inpLib2) { await pickSelectOption(inpLib2, ctx.library); await sleep(1500); }
            }
            if (libOk()) log('    · 商品库：' + ctx.library);
            else log('    ⚠ 商品库看起来不是「' + ctx.library + '」，先按当前库搜（搜不到会停下提示）', 'err');
          }

          d = getProductDialog() || d;
          await searchProductName(d, drama);
          var okPick = await pickProductByName(d, drama, '账户 ' + acc + ' ');
          if (!okPick) return;
          var cntAfter = prodSel();
          if (cntAfter > 1) log('    ⚠ 该账户已选 ' + cntAfter + ' 个产品（应为 1 个）', 'err');
          await sleep(700);
        }

        var okBtn = findDialogButton(d, ['确定']);
        if (!okBtn) throw new Error('「选择推广产品」的确定按钮不可点');
        forceClickOne(okBtn);
        var closed = await waitFor(function () { return !getProductDialog(); }, 8000, 300);
        if (!closed) throw new Error('点了确定但「选择推广产品」没关闭');
        log('  ✓ 推广产品已确定（' + ctx.accounts.length + ' 个账户）', 'ok');
        await sleep(800);
    }},

    // ===== 售卖策略（付费短剧，仅勾选时执行） =====
    { label: '售卖策略（付费）', fn: async function (ctx) {
        if (!ctx.strategy) { log('  · 未启用售卖策略，跳过'); return; }

        var dramasS = ctxDramas(ctx);
        var dramaOf = function (acc) {
          var i = ctx.accounts.indexOf(acc);
          return i >= 0 ? (dramasS[i] || ctx.drama || '') : (ctx.drama || '');
        };

        var dr = getInfoDrawer();
        if (!dr) throw new Error('「广告基本信息」抽屉不见了');

        // 1. 抽屉里点「修改/选择售卖策略」（新建广告时文案是「选择售卖策略」）
        var entry = findDialogButton(dr, ['修改已选售卖策略', '选择售卖策略']) ||
                    findTextEl(dr, '修改已选售卖策略') || findTextEl(dr, '选择售卖策略');
        if (!entry) throw new Error('没找到「修改已选售卖策略 / 选择售卖策略」按钮');
        forceClickOne(entry);
        await sleep(1800);

        var dlg = getDialogByTitle('短剧售卖策略');
        if (!dlg) throw new Error('「短剧售卖策略」弹窗没打开');
        log('  ✓ 已打开「短剧售卖策略」');

        // 2. 先解析表格：拿到「(账户ID, 短剧名) → 售卖策略」，后面直接从已有策略里选
        // 平台策略名 = 起充集数-单集价格-最低充值档位；
        // 名称列（B）与起充集数（C）对不上时，以起充集数所在行为准。
        // 表里如果有「短剧名」列，就按 账户+短剧名 区分（一个账户跑几部剧时必需）
        var specIdx = null;
        var dramaCol = '';
        var sMap = [];
        try {
          var parsedFile = await parseStrategyFile(ctx.strategy.b64);
          sMap = parsedFile.rows;
          dramaCol = parsedFile.dramaCol || '';
          specIdx = buildSpecIndex(sMap);

          var mmText = '';
          for (var mm = 0; mm < sMap.length && mm < 6; mm++) {
            var sp1 = specOf(sMap[mm]);
            mmText += (mm ? ', ' : '') + sMap[mm].account +
                      (sMap[mm].drama ? '|' + sMap[mm].drama : '') +
                      '=起充' + (sp1.ep || '?') + '集/' + (sp1.names[0] || '?');
            if (sp1.mismatch) {
              log('  ⚠ 账户 ' + sMap[mm].account + ' 名称列写的是「' + sMap[mm].strategy +
                  '」，但起充集数是 ' + sp1.ep + '（应为「' + sp1.names[0] + '」）→ 以起充集数为准', 'err');
            }
          }
          log('  · 表格解析到 ' + sMap.length + ' 条策略映射' +
              (dramaCol ? '（含「短剧名」列 ' + dramaCol + '，按 账户+短剧名 区分）'
                        : '（没有「短剧名」列）') + '：' + mmText);
          if (dramaCol && specIdx.ambiguous.length) {
            var noDrama = [];
            for (var adi = 0; adi < sMap.length; adi++) {
              if (specIdx.ambiguous.indexOf(sMap[adi].account) >= 0 && !sMap[adi].drama) noDrama.push(sMap[adi].account);
            }
            if (noDrama.length) {
              log('  ⚠ 这些账户有多条不同策略但「短剧名」列是空的：' + noDrama.join(' / ') + '（会按账户兜底取最后一条）', 'err');
            }
          } else if (!dramaCol && specIdx.ambiguous.length) {
            log('  ⚠ 这些账户在表里有多条不同策略，但没有「短剧名」列无法区分：' +
                specIdx.ambiguous.join(' / ') + '（一个账户跑多部剧时请加一列「短剧名」）', 'err');
          }

          var firstSel = specFor(specIdx, ctx.accounts[0], ctxDramas(ctx)[0]);
          log(firstSel && (firstSel.spec.ep || firstSel.spec.names.length)
              ? ('  · 账户 ' + ctx.accounts[0] + ' →「' + ctxDramas(ctx)[0] + '」应为：起充 ' +
                 firstSel.spec.ep + ' 集（' + firstSel.spec.names.join(' / ') + '）' +
                 (firstSel.match === 'drama' ? '' : '  ⚠ 不是按剧名匹配'))
              : ('  ⚠ 表格里没有账户 ' + ctx.accounts[0] + '，将选列表第一条'),
              (firstSel && (firstSel.spec.ep || firstSel.spec.names.length)) ? 'ok' : 'err');
        } catch (e) {
          log('  ⚠ 表格解析失败：' + e.message, 'err');
        }

        // 7. 在「短剧售卖策略」里按账户选择对应策略
        dlg = getDialogByTitle('短剧售卖策略');
        if (!dlg) throw new Error('导入后「短剧售卖策略」弹窗不见了');
        await sleep(1500);

        // 「已选 1/1」这种文案没有冒号，不能用 readSelectedCount
        var selCount = function () {
          var d = getDialogByTitle('短剧售卖策略') || dlg;
          if (!d) return -1;
          var t = (d.textContent || '').replace(/\s+/g, ' ');
          var m = t.match(/已选[：:\s]*(\d+)/);
          return m ? parseInt(m[1], 10) : -1;
        };

        // 取一行的单元格文本（优先 <tr>；否则向上找一块文字）
        var rowInfoOf = function (box) {
          var tr = null;
          try { tr = box.closest ? box.closest('tr') : null; } catch (e) {}
          var cells = [];
          if (tr) {
            var tds = tr.querySelectorAll('td');
            for (var i = 0; i < tds.length; i++) cells.push((tds[i].textContent || '').replace(/\s+/g, ' ').trim());
            return { el: tr, cells: cells, text: cells.join(' ') };
          }
          var scope = box, txt = '';
          for (var up = 0; up < 5 && scope; up++) {
            txt = (scope.textContent || '').replace(/\s+/g, ' ').trim();
            if (txt.length > 3) break;
            scope = scope.parentElement;
          }
          var toks = txt.split(/\s+/);
          for (var k = 0; k < toks.length; k++) if (toks[k]) cells.push(toks[k]);
          return { el: scope, cells: cells, text: txt };
        };

        /**
         * 找策略行的复选框。
         * 优先级：起充集数所在行（cell 匹配）> 名称命中 > 第一条
         */
        var findStrategyBox = function (spec) {
          var boxes = dlg.querySelectorAll('.el-checkbox, label.el-checkbox');
          var byCell = null, byName = null, first = null;
          var seen = [];
          var empty = !spec || (!spec.ep && (!spec.names || !spec.names.length));
          for (var ri = 0; ri < boxes.length; ri++) {
            var box = boxes[ri];
            if (!visible(box)) continue;
            var info = rowInfoOf(box);
            if (!info.text) continue;
            if (seen.length < 8) seen.push(info.text.slice(0, 24));
            if (!first) first = box;
            if (empty) continue;

            if (!byCell && specMatchCells(info.cells, spec)) byCell = box;

            if (!byName && spec.names && spec.names.length) {
              for (var ni = 0; ni < spec.names.length; ni++) {
                if (nameHit(info.text, spec.names[ni])) { byName = box; break; }
              }
            }
          }
          if (empty) return { el: first, byCell: false, seen: seen };
          return { el: byCell || byName, byCell: !!byCell, seen: seen };
        };

        var searchStrategyList = async function (kw) {
          var sInp = null;
          var inputs2 = dlg.querySelectorAll('input');
          for (var i2 = 0; i2 < inputs2.length; i2++) {
            var ip = inputs2[i2];
            if (!visible(ip)) continue;
            if (ip.type === 'checkbox' || ip.type === 'radio' || ip.readOnly) continue;
            var ph = ip.placeholder || '';
            if (ph.indexOf('关键词') >= 0 || ph.indexOf('搜索') >= 0 || ph.indexOf('策略') >= 0) { sInp = ip; break; }
          }
          if (!sInp) return;
          setInputValue(sInp, '');
          await sleep(250);
          await typeChars(sInp, kw);
          commitSearch(sInp);
          await sleep(600);
          var sBtn2 = dlg.querySelector('.cl-search-input__submit');
          if (sBtn2 && visible(sBtn2)) { forceClickOne(sBtn2); await sleep(1000); }
          else await sleep(900);
        };

        // 等策略列表渲染出来（切账户/搜索后是异步刷新的）
        var waitStrategyList = async function () {
          var t0 = Date.now();
          while (Date.now() - t0 < 5000) {
            var boxes = dlg.querySelectorAll('.el-checkbox, label.el-checkbox');
            for (var bi = 0; bi < boxes.length; bi++) {
              if (visible(boxes[bi])) return true;
            }
            await sleep(300);
          }
          return false;
        };

        /** 策略列表的搜索框 */
        var findStrategySearchInput = function () {
          var ins = dlg.querySelectorAll('input');
          for (var i = 0; i < ins.length; i++) {
            if (!visible(ins[i])) continue;
            if (ins[i].type === 'checkbox' || ins[i].type === 'radio' || ins[i].readOnly) continue;
            var ph = ins[i].placeholder || '';
            if (ph.indexOf('关键词') >= 0 || ph.indexOf('搜索') >= 0 || ph.indexOf('策略') >= 0) return ins[i];
          }
          return null;
        };

        /** 点列表上方的「刷新」，把被搜索过滤空的列表重新拉回来 */
        var refreshStrategyList = async function () {
          var list = dlg.querySelectorAll('button, span, a, i');
          for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (!visible(el)) continue;
            if ((el.textContent || '').replace(/\s+/g, '').trim() !== '刷新') continue;
            var r = el.getBoundingClientRect();
            if (r.width > 80 || r.height > 32) continue;
            forceClickOne(el);
            log('    · 已点「刷新」重载策略列表');
            await sleep(1800);
            return true;
          }
          return false;
        };

        /** 翻到第 n 页 */
        var gotoStrategyPage = async function (n) {
          var lis = dlg.querySelectorAll('.el-pager li, .el-pagination li, .el-pager span, .el-pagination span, .el-pagination button');
          for (var i = 0; i < lis.length; i++) {
            if (!visible(lis[i])) continue;
            if ((lis[i].textContent || '').trim() !== String(n)) continue;
            forceClickOne(lis[i]);
            await sleep(1600);
            return true;
          }
          return false;
        };

        /** 当前账户已勾选的那一行 */
        var findCheckedStrategy = function () {
          var boxes = dlg.querySelectorAll('label.el-checkbox, .el-checkbox');
          for (var i = 0; i < boxes.length; i++) {
            if (!visible(boxes[i])) continue;
            if (!isLabelChecked(boxes[i])) continue;
            var info = rowInfoOf(boxes[i]);
            if (info && info.text) return { el: boxes[i], info: info };
          }
          return null;
        };

        /** 删掉当前账户已选的售卖策略（旧策略占着位置时，新策略会变成不可选） */
        var clearStrategySel = async function () {
          // 1) 点掉已勾选那一行
          for (var round = 0; round < 2; round++) {
            var ck = findCheckedStrategy();
            if (!ck) break;
            forceClickOne(ck.el);
            await sleep(800);
            if (isLabelChecked(ck.el)) {
              var inner = ck.el.querySelector('.el-checkbox__inner');
              if (inner) { forceClickOne(inner); await sleep(800); }
            }
            if (isLabelChecked(ck.el)) break;
          }
          if (selCount() <= 0) return true;

          // 2) 还勾着 → 点「已选 N」旁边的「清空」
          var clr = findClearInDialog(dlg);
          if (clr) {
            forceClickOne(clr);
            await sleep(1000);
            var conf = findClearConfirm();
            if (conf) { forceClickOne(conf); await sleep(900); }
          }
          return selCount() <= 0;
        };

        // 给某个账户勾上它对应的策略；spec = {ep, price, recharge, names}
        // 顺序：先删旧策略 → 全量列表按起充集数找 → 刷新 → 翻页 → 才用搜索框
        var pickFor = async function (acc, spec) {
          var tag = ctx.accounts.length > 1 ? ('账户 ' + acc + ' ') : '';
          var empty = !spec || (!spec.ep && (!spec.names || !spec.names.length));
          var found = null;
          var chosen = '';

          var labelOf = function (r) {
            if (empty) return '列表第一条';
            return r.byCell ? ('起充 ' + spec.ep + ' 集') : (spec.names[0] || '');
          };

          // 1) 上一次搜索可能把列表过滤空了 → 先清空搜索
          var sInp0 = findStrategySearchInput();
          if (sInp0 && (sInp0.value || '').trim()) {
            await clearStrategySearch(dlg);
            await sleep(900);
          }
          await waitStrategyList();
          // 列表完全空 → 不用再刷新/翻页/搜索（那要空跑 20 多秒），直接交给调用方去导入
          if (!countListRows()) {
            log('  · ' + tag + '策略列表为空，跳过查找');
            return false;
          }

          // 2) 先处理这个账户原有的策略：已经是目标就跳过；不是就先删掉
          var cur = findCheckedStrategy();
          if (cur && !empty) {
            var curOk = specMatchCells(cur.info.cells, spec) || nameHit(cur.info.text, (spec.names || [])[0] || '');
            if (curOk) {
              log('  · ' + tag + '已是目标策略：' + cur.info.text.slice(0, 40), 'ok');
              return true;
            }
            log('  · ' + tag + '原有策略不同，先删掉：' + cur.info.text.slice(0, 40));
            await clearStrategySel();
            await sleep(1200);
            await waitStrategyList();
          }

          found = findStrategyBox(empty ? null : spec);
          if (found.el) chosen = labelOf(found);

          // 2) 列表空 → 点「刷新」
          if (!found.el) {
            await refreshStrategyList();
            await waitStrategyList();
            found = findStrategyBox(empty ? null : spec);
            if (found.el) chosen = labelOf(found);
          }

          // 3) 翻页找（最多 5 页）
          if (!found.el && !empty) {
            for (var pg = 2; pg <= 5 && !found.el; pg++) {
              if (!(await gotoStrategyPage(pg))) break;
              await waitStrategyList();
              found = findStrategyBox(spec);
              if (found.el) chosen = labelOf(found);
            }
          }

          // 4) 最后才用搜索（只用推算名/名称列，不用光秃秃的数字）
          if (!found.el && !empty) {
            for (var ni = 0; ni < spec.names.length && !found.el; ni++) {
              var nm = spec.names[ni];
              if (!nm) continue;
              await searchStrategyList(nm);
              await waitStrategyList();
              found = findStrategyBox(spec);
              if (found.el) chosen = nm;
            }
            if (!found.el) {
              await clearStrategySearch(dlg);
              await sleep(1200);
              await waitStrategyList();
              found = findStrategyBox(spec);
              if (found.el) chosen = labelOf(found);
            }
          }

          if (!found || !found.el) {
            log('  ✗ ' + tag + '策略列表里没找到对应行（起充 ' + (spec && spec.ep ? spec.ep : '?') +
                ' 集 / ' + ((spec && spec.names) ? spec.names.join(' 或 ') : '任意') + '），可见：' +
                (found ? found.seen.slice(0, 6).join(' / ') : ''), 'err');
            return false;
          }

          // 目标行还是灰色 → 说明旧策略没删干净，再删一次
          if (!empty && String(found.el.className || '').indexOf('is-disabled') >= 0) {
            log('  · ' + tag + '目标策略行还是灰色，再删一次旧策略', 'err');
            await clearStrategySel();
            await sleep(1200);
            await waitStrategyList();
            var re = findStrategyBox(spec);
            if (re.el) { found = re; chosen = labelOf(re); }
          }

          var beforeSel = selCount();
          if (isLabelChecked(found.el)) {
            log('  · ' + tag + '策略已是选中状态：' + chosen);
            return true;
          }
          var ok = await clickLabelCheckbox(found.el);
          await sleep(700);
          if (!ok) {
            log('  · ' + tag + '第一次勾选没生效，再点一次', 'err');
            await clickLabelCheckbox(found.el);
            await sleep(700);
          }
          var afterSel = selCount();
          log('  · ' + tag + '已选售卖策略：' + afterSel + '（勾选前 ' + beforeSel + '，目标 ' + chosen + '）');

          // 勾完回读：当前被选中的那一行到底是不是我们要的
          var ck = null;
          var boxes2 = dlg.querySelectorAll('label.el-checkbox, .el-checkbox');
          for (var ck2 = 0; ck2 < boxes2.length; ck2++) {
            if (!visible(boxes2[ck2])) continue;
            if (!isLabelChecked(boxes2[ck2])) continue;
            ck = rowInfoOf(boxes2[ck2]);
            if (ck && ck.text) break;
          }
          if (ck && ck.text) {
            var ckOk = empty ? true : (specMatchCells(ck.cells, spec) || nameHit(ck.text, (spec.names || [])[0] || ''));
            log('    · 当前选中的策略行：' + ck.text.slice(0, 40) + (ckOk ? '' : '  ⚠ 与目标不符'), ckOk ? 'ok' : 'err');
          }
          return isLabelChecked(found.el) || afterSel > 0;
        };

        /** 批量导入一次 xlsx —— 只有「列表里确实缺某个账户的策略」时才调用 */
        var runImport = async function () {
          dlg = getDialogByTitle('短剧售卖策略') || dlg;
          var nbtn = findDialogButton(dlg, ['新建售卖策略']);
          if (!nbtn) throw new Error('没找到「新建售卖策略」');
          forceClickOne(nbtn);
          await sleep(1600);

          var ndlg = getDialogByTitle('新建售卖策略');
          if (!ndlg) throw new Error('「新建售卖策略」弹窗没打开');
          log('  ✓ 已打开「新建售卖策略」');

          var batch = findTextEl(ndlg, '批量导入新建') || findTextEl(ndlg, '批量导入');
          if (batch) { forceClickOne(batch); await sleep(900); log('  · 已切到「批量导入新建」'); }

          var input = ndlg.querySelector('input[type=file].el-upload__input') || ndlg.querySelector('input[type=file]');
          if (!input) throw new Error('没找到上传用的 file input');

          // 表里有「短剧名」列时，上传前把这列删掉：平台模板仍是 5 列，避免被判模板错误。
          // 删完会用同一个解析器回读校验，校验不过就按原文件上传。
          var upB64 = ctx.strategy.b64;
          if (dramaCol) {
            try {
              var stripped = await stripStrategyColumn(ctx.strategy.b64, dramaCol);
              var chkRows = await parseStrategyXlsx(stripped);
              var leftDrama = 0;
              for (var ck3 = 0; ck3 < chkRows.length; ck3++) if (chkRows[ck3].drama) leftDrama++;
              if (leftDrama) throw new Error('剧名列没删干净');
              if (sMap.length && chkRows.length !== sMap.length) {
                throw new Error('行数对不上（' + chkRows.length + '/' + sMap.length + '）');
              }
              upB64 = stripped;
              log('  · 上传文件已去掉「短剧名」列（平台模板仍是 5 列，' + chkRows.length + ' 行）');
            } catch (eS) {
              log('  ⚠ 「短剧名」列没去掉（' + eS.message + '），按原文件上传', 'err');
            }
          }

          var bin = atob(upB64);
          var arr = new Uint8Array(bin.length);
          for (var bi = 0; bi < bin.length; bi++) arr[bi] = bin.charCodeAt(bi);
          var file = new File([arr], ctx.strategy.name, {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          });
          var dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          log('  · 已注入文件：' + ctx.strategy.name + '（' + arr.length + ' 字节）');
          await sleep(1500);

          var okBtn = findDialogButton(ndlg, ['确定']);
          if (!okBtn) throw new Error('「新建售卖策略」的确定按钮不可点（文件没被接收）');
          forceClickOne(okBtn);
          log('  · 已点确定，等待导入…');
          await sleep(3000);

          var failTimes = await closeFailDetailDlg(12000);
          if (failTimes) log('  · 已有同名策略，自动关闭「失败详情」' + failTimes + ' 次', 'ok');

          var errMsg = '';
          var msgs = document.querySelectorAll('.el-message--error, .el-message.is-error');
          for (var mi = 0; mi < msgs.length; mi++) {
            if (visible(msgs[mi])) errMsg = (msgs[mi].textContent || '').trim();
          }
          if (errMsg) throw new Error('导入报错：' + errMsg.slice(0, 80));

          var ndlgGone = await waitFor(function () { return !getDialogByTitle('新建售卖策略'); }, 8000, 500);
          if (!ndlgGone) {
            var nd2 = getDialogByTitle('新建售卖策略');
            var cBtn = findDialogButton(nd2, ['取消']);
            if (cBtn) forceClickOne(cBtn);
            await sleep(1500);
          }
          await closeFailDetailDlg(3000);
          log('  ✓ 批量导入完成', 'ok');
          dlg = getDialogByTitle('短剧售卖策略') || dlg;
          await sleep(1200);
        };

        // 7.0 新建账户一条售卖策略都没有 → 先批量导入，别空跑一遍选择
        var countListRows = function () {
          dlg = getDialogByTitle('短剧售卖策略') || dlg;
          if (!dlg) return 0;
          var rows = dlg.querySelectorAll('label.el-checkbox, .el-checkbox, tbody tr');
          var n = 0;
          for (var ri = 0; ri < rows.length; ri++) {
            if (!visible(rows[ri])) continue;
            var rt = (rows[ri].textContent || '').replace(/\s+/g, '');
            if (!rt || rt.indexOf('暂无数据') >= 0 || rt.indexOf('无数据') >= 0) continue;
            n++;
          }
          return n;
        };
        var importedOnce = false;
        var ensureStrategyImported = async function (tag) {
          var n = countListRows();
          if (n === 0) {
            await waitStrategyList();          // 给它 5 秒渲染
            n = countListRows();
          }
          if (n > 0) return false;
          if (importedOnce) {
            log('  · ' + tag + '策略列表还是空的（本轮已导入过，不重复上传）', 'err');
            return false;
          }
          log('  · ' + tag + '策略列表是空的（新账户还没有售卖策略），先批量导入', 'info');
          importedOnce = true;
          await runImport();
          await refreshStrategyList();
          await waitStrategyList();
          log('  · 导入后策略行数：' + countListRows());
          return true;
        };

        // 7.1 售卖策略永远按账户逐个填（统一模式也一样，不能用「统一配置」）
        var targets = [ctx.accounts[0]];
        if (ctx.accounts.length > 1) {
          var okSr = await activateChoice(dlg, ['按账户分配', '分配到账户']);
          if (okSr) {
            await confirmTipIfAny();
            await sleep(1200);
            dlg = getDialogByTitle('短剧售卖策略') || dlg;
          }
          var nodeCount = 0;
          var countAccounts = function () {
            var dl = getDialogByTitle('短剧售卖策略') || dlg;
            dlg = dl;
            var n = countAccountNodes(dl, ctx.accounts);
            if (n < ctx.accounts.length) n = Math.max(n, countAccountNodes(document, ctx.accounts));
            nodeCount = n;
          };
          countAccounts();
          if (nodeCount < ctx.accounts.length) {
            await sleep(700);          // 只给一次重渲染的机会，不做长时间等待
            countAccounts();
          }
          if (nodeCount >= 2) {
            targets = ctx.accounts;
            log('  · 分配规则：按账户分配（' + nodeCount + ' 个账户逐个选）', 'ok');
          } else if (nodeCount === 1) {
            // 只认出 1 个也不硬中断：照常逐个切账户，切不过去的会打警告跳过
            targets = ctx.accounts;
            log('  ⚠ 左侧只认出 1/' + ctx.accounts.length + ' 个账户，仍按逐个切换尝试', 'err');
          } else {
            // 诊断：把页面上所有「account」相关节点、以及像账号的 input 值都打出来
            var probe = [];
            var cands = document.querySelectorAll('[class*="account"]');
            for (var pi = 0; pi < cands.length && probe.length < 10; pi++) {
              var pe = cands[pi];
              var pt = (pe.textContent || '').replace(/\s+/g, '').trim();
              var pv = (pe.tagName === 'INPUT') ? String(pe.value || '').trim() : '';
              if (!pt && !pv) continue;
              if ((pt || pv).length > 24) continue;
              var pr = pe.getBoundingClientRect();
              probe.push(pe.tagName + '.' + String(pe.className || '').slice(0, 22) +
                         '[' + (pt || pv) + ']' + Math.round(pr.width) + 'x' + Math.round(pr.height));
            }
            var idLike = [];
            var ins = document.querySelectorAll('input');
            for (var ii = 0; ii < ins.length && idLike.length < 6; ii++) {
              var iv = String(ins[ii].value || '').trim();
              if (/^\d{6,}$/.test(iv)) idLike.push(iv);
            }
            log('  诊断·account 类节点：' + (probe.join(' | ') || '（一个都没有）'), 'err');
            log('  诊断·.account-name=' + document.querySelectorAll('.account-name').length +
                '，title=账号 命中=' + document.querySelectorAll('[title="' + ctx.accounts[0] + '"]').length +
                '，带账号值的 input：' + (idLike.join(',') || '（无）'), 'err');
            throw new Error('「短剧售卖策略」左侧认不出账户（' + nodeCount + '/' + ctx.accounts.length +
                            '），请把上面两行「诊断」发给我');
          }
        }

        var picked = 0;
        var failed = [];
        for (var ti = 0; ti < targets.length; ti++) {
          var acc2 = targets[ti];
          if (targets.length > 1) {
            var okAcc2 = await clickAccountRow(dlg, acc2);
            if (!okAcc2) {
              log('  · 账户 ' + acc2 + ' 第一次没切过去，再试一次', 'err');
              await sleep(800);
              okAcc2 = await clickAccountRow(getDialogByTitle('短剧售卖策略') || dlg, acc2);
            }
            if (!okAcc2) {
              if (ti === 0) log('  · 左侧没有可切换的账户，按当前账户选一次', 'info');
              else { log('  ⚠ 账户 ' + acc2 + ' 切不过去，跳过', 'err'); continue; }
            } else {
              dlg = getDialogByTitle('短剧售卖策略') || dlg;
              log('  · 已切到账户 ' + acc2);
              await sleep(900);
            }
          }
          await ensureStrategyImported('账户 ' + acc2 + ' ');
          var spPick = specFor(specIdx, acc2, dramaOf(acc2));
          if (spPick && spPick.match !== 'drama') {
            log('    ⚠ 账户 ' + acc2 + ' 没按剧名匹配到策略（' + spPick.match + '），用兜底：起充 ' + (spPick.spec.ep || '?') + ' 集', 'err');
          }
          var okPick = await pickFor(acc2, spPick ? spPick.spec : null);

          // 这个账户缺策略（列表里没有，但列表本身不是空的）→ 立刻导入一次再重试本账户，
          // 不能等所有账户跑完才导入：后面的账户会一路失败、白等好几轮
          if (!okPick && !importedOnce) {
            log('  · 账户 ' + acc2 + ' 缺对应策略（起充 ' + (spPick ? (spPick.spec.ep || '?') : '?') +
                ' 集），先批量导入一次再重试', 'err');
            importedOnce = true;
            try {
              await runImport();
              await refreshStrategyList();
              await waitStrategyList();
              dlg = getDialogByTitle('短剧售卖策略') || dlg;
              if (targets.length > 1) {
                if (await clickAccountRow(dlg, acc2)) {
                  dlg = getDialogByTitle('短剧售卖策略') || dlg;
                  await sleep(900);
                } else {
                  log('  ⚠ 导入后切不回账户 ' + acc2, 'err');
                }
              }
              okPick = await pickFor(acc2, spPick ? spPick.spec : null);
            } catch (eImp) {
              log('  ⚠ 导入没成功：' + eImp.message, 'err');
            }
          }

          if (okPick) picked++;
          else failed.push(acc2);
          await sleep(400);
        }

        // 列表里确实缺策略 → 这时才批量导入一次（已存在的会提示重复，自动关掉），然后重试
        if (failed.length) {
          if (importedOnce) {
            log('  ⚠ 本轮已经导入过，' + failed.join(' / ') + ' 仍找不到对应行（请检查表格里的账户/起充集数）', 'err');
          } else {
            log('  · 有 ' + failed.length + ' 个账户在列表里找不到策略（' + failed.join(' / ') + '），执行一次批量导入', 'err');
            importedOnce = true;
            await runImport();
            await refreshStrategyList();
            await waitStrategyList();
            for (var fi = 0; fi < failed.length; fi++) {
              var facc = failed[fi];
              dlg = getDialogByTitle('短剧售卖策略') || dlg;
              if (targets.length > 1) {
                var okF = await clickAccountRow(dlg, facc);
                if (okF) {
                  dlg = getDialogByTitle('短剧售卖策略') || dlg;
                  log('  · 已切到账户 ' + facc);
                  await sleep(900);
                }
              }
              var spF = specFor(specIdx, facc, dramaOf(facc));
              if (await pickFor(facc, spF ? spF.spec : null)) picked++;
              await sleep(400);
            }
          }
        } else if (picked) {
          log('  · 策略都已存在，跳过批量导入（不重复上传，也不会再弹「失败详情」）', 'ok');
        }

        if (!picked) throw new Error('没有选中任何售卖策略');

        // 7.2 确定
        var dOk = findDialogButton(dlg, ['确定']);
        if (!dOk) throw new Error('「短剧售卖策略」确定按钮不可点');
        forceClickOne(dOk);
        var dClosed = await waitFor(function () { return !getDialogByTitle('短剧售卖策略'); }, 8000, 300);
        if (!dClosed) throw new Error('点了确定但「短剧售卖策略」没关闭');
        log('  ✓ 售卖策略已确定（' + picked + ' 个账户）', 'ok');
        await sleep(800);
    }},

    // 13. 保存「广告基本信息」抽屉
    { label: '保存广告基本信息', fn: async function (ctx) {
        var dr = getInfoDrawer();
        if (!dr) { log('  · 抽屉已关闭，跳过', 'info'); return; }
        var btn = findDialogButton(dr, ['保存']);
        if (!btn) {
          log('  ⚠ 抽屉里没找到「保存」，按钮：' + collectDialogButtons(dr), 'err');
          throw new Error('抽屉里没找到「保存」');
        }
        forceClickOne(btn);
        var closed = await waitFor(function () { return !getInfoDrawer(); }, 8000, 300);
        if (!closed) throw new Error('点了「保存」但抽屉没关闭');
        log('  ✓ 广告基本信息已保存', 'ok');
        await sleep(1200);
    }},

    // 14. 创意素材：多账户「分账户选择」——每个账户各自 清空 → 添加视频 → 前2页全选 → 提交 → 乱序 3 次
    { label: '创意素材（按账户）', fn: async function (ctx) {
        var dramas = ctxDramas(ctx);
        var dr = getCreativeDrawer();
        if (!dr) {
          var el = clickColumnAction('创意素材', '选择素材');
          if (!el) el = findAndClick('选择素材', { exact: true, tags: 'button' }) ||
                          findAndClick('选择素材', { exact: false });
          if (!el) throw new Error('没找到「选择素材」');
          var opened = await waitFor(function () { return !!getCreativeDrawer(); }, 10000, 350);
          if (!opened) throw new Error('点了「选择素材」但素材抽屉没出现');
          log('  ✓ 创意素材抽屉已打开', 'ok');
          await sleep(1000);
          dr = getCreativeDrawer();
        }

        var uniC = ctxUnified(ctx);
        var targetsC = uniC ? [ctx.accounts[0]] : ctx.accounts;

        if (ctx.accounts.length > 1) {
          if (uniC) {
            // 统一模式：素材只认「平均分配」——是就继续，不切账户、也不因为认不出就中断
            // （是否统一模式只看面板页签，不看短剧名是否相同）
            var avg = findRuleCard(dr, '平均分配');
            if (!avg) {
              dr = getCreativeDrawer() || dr;
              avg = findRuleCard(dr, '平均分配');
            }
            if (avg && !isChoiceActive(avg)) {
              forceClickOne(avg);
              await sleep(1400);
              await confirmTipIfAny();
              dr = getCreativeDrawer() || dr;
              avg = findRuleCard(dr, '平均分配') || avg;
            }
            if (avg && isChoiceActive(avg)) {
              log('  · 分配规则：平均分配（直接继续，不切账户）', 'ok');
            } else if (avg) {
              log('  · 分配规则：没点成「平均分配」，按当前状态继续', 'err');
            } else {
              log('  · 没看到「平均分配」选项，按当前状态继续', 'info');
            }
            await sleep(600);
          } else {
            var okRule = await activateChoice(dr, ['分账户选择', '按账户选择']);
            if (okRule) log('  · 分配规则：分账户选择（逐个账户选素材）', 'ok');
            else log('  ⚠ 没找到「分账户选择」，按当前状态继续', 'err');
            await confirmTipIfAny();
            await sleep(1500);
          }
        }

        for (var ai = 0; ai < targetsC.length; ai++) {
          var acc = targetsC[ai];
          var drama = dramas[ai];
          if (uniC) {
            log('  【统一】' + targetsC.join(' / ') + ' 共用 → 「' + drama + '」');
          } else {
            log('  【' + (ai + 1) + '/' + targetsC.length + '】账户 ' + acc + ' → 「' + drama + '」');
          }

          dr = getCreativeDrawer();
          if (!dr) throw new Error('素材抽屉不见了');

          if (!uniC && ctx.accounts.length > 1) {
            var okTab = await clickAccountTab(dr, acc);
            if (!okTab) throw new Error('素材抽屉顶部没找到账户 ' + acc + ' 的标签');
            await sleep(900);
            dr = getCreativeDrawer();
          }

          await creativeClear(dr);
          await creativeAddVideo(dr);

          var md = getMaterialDialog();
          if (!md) throw new Error('素材库没打开');

          // 只在第一个账户做一次：清空筛选 → 勾选配置的素材目录 → 收起
          // （第一个账户的素材模板会沿用到后面所有账户，所以这里一次就够了）
          if (ai === 0) {
            log('    · 第一个账户：先清空筛选，再把素材目录切到「' + ctx.materialFolder + '」');
            await materialPickFolder(md, ctx.materialFolder);
            md = getMaterialDialog() || md;
          }

          // 搜不到这部剧的素材 → 暂停等你上传，上传后从当前账户接着做
          md = await searchMaterialWithManualWait(md, drama, ctx.materialFolder);

          // 搜索会让筛选区重渲染，素材目录可能被重置回「全部」→ 搜索后再确认/补勾
          var keep = await materialEnsureFolder(md, ctx.materialFolder);
          if (keep.applied) {
            log('    · 已重新勾选素材目录「' + ctx.materialFolder + '」' + (keep.ok ? '' : '（没勾上）'), keep.ok ? 'ok' : 'err');
            // 重设文件夹可能把关键词清掉 → 关键词空了就再搜一次
            var kwNow = findMaterialSearchInput(md);
            if (kwNow && !String(kwNow.value || '').trim()) await materialSearch(md, drama);
          }

          await materialSelectFirstTwoPages(md);
          await materialSubmit(md);

          dr = getCreativeDrawer();
          if (!dr) throw new Error('素材抽屉不见了（提交后）');
          await creativeShuffle(dr, 3);
          log('    ✓ ' + (uniC ? '全部账户' : ('账户 ' + acc)) + ' 素材已配置（前2页全选 + 乱序3次）', 'ok');
        }

        dr = getCreativeDrawer();
        if (!dr) { log('  · 素材抽屉已关闭，跳过', 'info'); return; }
        var okBtn = findDialogButton(dr, ['确定', '保存']);
        if (!okBtn) throw new Error('素材抽屉没有可点的「确定」');
        forceClickOne(okBtn);
        var closed = await waitFor(function () { return !getCreativeDrawer(); }, 10000, 350);
        if (!closed) throw new Error('点了「确定」但素材抽屉没关闭');
        log('  ✓ 素材配置已确定', 'ok');
        await sleep(1500);
    }},

    // 15. 清空已选素材
    { label: '素材抽屉 - 清空', fn: async function (ctx) {
        var dr = getCreativeDrawer();
        if (!dr) throw new Error('素材抽屉不见了');
        var btn = findDialogButton(dr, ['清空']);
        if (btn) { forceClickOne(btn); log('  ✓ 已清空已选素材', 'ok'); await sleep(1200); }
        else log('  ⚠ 没找到「清空」（可能本来就没选）', 'info');
    }},

    // 16. 批量添加 → 添加视频 → 打开素材库
    { label: '批量添加视频', fn: async function (ctx) {
        var dr = getCreativeDrawer();
        if (!dr) throw new Error('素材抽屉不见了');
        if (getMaterialDialog()) { log('  · 素材库已打开，跳过', 'info'); return; }

        // 找「批量添加」的 dropdown（排除「批量添加组图」）
        var dd = null;
        var dds = dr.querySelectorAll('.el-dropdown, .el-dropdown-selfdefine');
        for (var i = 0; i < dds.length; i++) {
          var t = (dds[i].textContent || '').replace(/\s+/g, '');
          if (t.indexOf('批量添加') >= 0 && t.indexOf('组图') < 0) { dd = dds[i]; break; }
        }
        if (!dd) throw new Error('没找到「批量添加」下拉');

        // hover 展开
        var r = dd.getBoundingClientRect();
        var evs = ['pointerenter', 'mouseenter', 'pointerover', 'mouseover', 'mousemove'];
        for (var e1 = 0; e1 < evs.length; e1++) {
          try {
            dd.dispatchEvent(new MouseEvent(evs[e1], {
              bubbles: true, cancelable: true, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
            }));
          } catch (e) {}
        }
        await sleep(1200);

        var menu = null;
        var menus = document.querySelectorAll('.el-dropdown-menu');
        for (var m = menus.length - 1; m >= 0; m--) {
          if (visible(menus[m]) && (menus[m].textContent || '').indexOf('添加视频') >= 0) { menu = menus[m]; break; }
        }
        if (!menu) {
          forceClickOne(dd.querySelector('button') || dd);
          await sleep(1500);
          menus = document.querySelectorAll('.el-dropdown-menu');
          for (var m2 = menus.length - 1; m2 >= 0; m2--) {
            if (visible(menus[m2]) && (menus[m2].textContent || '').indexOf('添加视频') >= 0) { menu = menus[m2]; break; }
          }
        }

        // 兜底：hover 打不开也没关系，直接从 DOM 里找那个菜单项点（菜单是挂在 body 上的隐藏节点）
        if (!menu) {
          var allMenus = document.querySelectorAll('.el-dropdown-menu');
          for (var m3 = allMenus.length - 1; m3 >= 0; m3--) {
            if ((allMenus[m3].textContent || '').indexOf('添加视频') >= 0) { menu = allMenus[m3]; break; }
          }
          if (menu) log('  · 下拉没展开，直接从隐藏菜单里点');
        }
        if (!menu) throw new Error('没找到含「添加视频」的下拉菜单');

        var item = null;
        var lis = menu.querySelectorAll('li, .el-dropdown-menu__item');
        var itemTexts = [];
        for (var j = 0; j < lis.length; j++) {
          var lt = (lis[j].textContent || '').replace(/\s+/g, '').trim();
          if (!lt) continue;
          itemTexts.push(lt);
          if (lt === '添加视频' && !item) item = lis[j];
        }
        if (!item) throw new Error('下拉菜单里没有「添加视频」：' + itemTexts.join('/'));

        forceClickOne(item);
        var opened = await waitFor(function () { return !!getMaterialDialog(); }, 12000, 400);
        if (!opened) throw new Error('点了「添加视频」但素材库没打开');
        log('  ✓ 素材库已打开', 'ok');
        await sleep(1200);
    }},

    // 17. 素材库搜索剧名
    { label: '素材库 - 搜索剧名', fn: async function (ctx) {
        var d = getMaterialDialog();
        if (!d) throw new Error('素材库没打开');

        var inputs = d.querySelectorAll('input');
        var target = null;
        for (var i = 0; i < inputs.length; i++) {
          if (!visible(inputs[i])) continue;
          var ph = inputs[i].placeholder || '';
          if (ph.indexOf('关键词') >= 0) { target = inputs[i]; break; }
        }
        if (!target) {
          for (var j = 0; j < inputs.length; j++) {
            var inp = inputs[j];
            if (!visible(inp)) continue;
            if (inp.type === 'checkbox' || inp.type === 'radio') continue;
            if ((inp.placeholder || '').indexOf('请选择') === 0) continue;
            target = inp; break;
          }
        }
        if (!target) throw new Error('没找到素材库搜索框');

        // 文档：先点搜索文本框的「清空」按钮
        var clearIcon = null;
        var wrap = target.parentElement;
        for (var c = 0; c < 3 && wrap; c++) {
          var icons = wrap.querySelectorAll('i, span');
          for (var ci = 0; ci < icons.length; ci++) {
            var cls = String(icons[ci].className || '');
            if (cls.indexOf('clear') >= 0 || cls.indexOf('close') >= 0) { clearIcon = icons[ci]; break; }
          }
          if (clearIcon) break;
          wrap = wrap.parentElement;
        }
        if (clearIcon) { forceClickOne(clearIcon); await sleep(600); }
        try { target.readOnly = false; target.removeAttribute('readonly'); } catch (e) {}
        target.value = '';
        target.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(400);

        // 素材命名里不带冒号，搜索时必须去掉冒号，否则搜不到
        var mateKw = ctx.drama.replace(/[：:]/g, '');
        log('  · 素材搜索关键词（已去冒号）：' + mateKw);

        await typeChars(target, mateKw);
        await sleep(800);
        target.focus();
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        } catch (e) {}
        commitSearch(target);
        await sleep(600);

        // 素材库的搜索按钮是「纯图标按钮」（.cl-search-input__submit），没有文字，不能按文字找
        var sbtn = null;
        var candidates = d.querySelectorAll('.cl-search-input__submit, .el-input-group__append button, button');
        for (var sb = 0; sb < candidates.length; sb++) {
          var cb2 = candidates[sb];
          if (!visible(cb2) || isDisabled(cb2)) continue;
          if (String(cb2.className || '').indexOf('cl-search-input__submit') >= 0) { sbtn = cb2; break; }
        }
        if (!sbtn) {
          // 退化：找关键词输入框右侧最近的按钮
          var ir = target.getBoundingClientRect();
          var bestD = 1e9;
          for (var sb2 = 0; sb2 < candidates.length; sb2++) {
            var b2 = candidates[sb2];
            if (!visible(b2) || isDisabled(b2)) continue;
            var br2 = b2.getBoundingClientRect();
            var dy2 = Math.abs((br2.top + br2.height / 2) - (ir.top + ir.height / 2));
            var dx2 = br2.left - ir.right;
            if (dy2 > 30 || dx2 < -12 || dx2 > 90) continue;
            if (dx2 < bestD) { bestD = dx2; sbtn = b2; }
          }
        }

        if (sbtn) {
          forceClickOne(sbtn);
          log('  · 已点搜索按钮');
        } else {
          commitSearch(target);
          log('  ⚠ 没找到搜索按钮，改用 change 事件', 'err');
        }
        await sleep(4000);

        // 校验：读分页的「共 N 条」，确认过滤生效
        var pageTxt = (d.textContent || '').replace(/\s+/g, ' ');
        var mCnt = pageTxt.match(/共\s*(\d+)\s*条/);
        if (mCnt) {
          log('  · 搜索后共 ' + mCnt[1] + ' 条素材');
          if (parseInt(mCnt[1], 10) === 0) {
            throw new Error('素材库里没搜到「' + mateKw + '」的素材，请检查素材命名');
          }
        }
        log('  ✓ 已搜索：' + mateKw, 'ok');
    }},

    // 18. 前 2 页全选（文档：点左下角的全选，第一页、第二页都要选）
    { label: '前 2 页全选', fn: async function (ctx) {
        var d = getMaterialDialog();
        if (!d) throw new Error('素材库没打开');

        var dr = d.getBoundingClientRect();

        var findSelectAll = function () {
          var list = d.querySelectorAll('label.el-checkbox, label, span, button');
          var best = null, bestTop = -1e9;
          for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (!visible(el)) continue;
            if ((el.textContent || '').replace(/\s+/g, '').trim() !== '全选') continue;
            var r = el.getBoundingClientRect();
            if (r.width > 90) continue;          // 排除整块容器
            if (r.top > bestTop) { bestTop = r.top; best = el; }   // 取最靠下的那个（列表底部）
          }
          return best;
        };

        var doSelectAll = async function (label) {
          if (!label) return false;
          var box = label.closest ? label.closest('label.el-checkbox') : null;
          var before = readSelectedCount(d);
          forceClickOne(box || label);
          await sleep(1800);
          var after = readSelectedCount(d);
          if (before === after) {
            // 没生效，再点内部的 checkbox 方块
            var inner = (box || label).querySelector('.el-checkbox__inner, .el-checkbox__input');
            if (inner) { forceClickOne(inner); await sleep(1800); after = readSelectedCount(d); }
          }
          log('    · 全选后已选素材：' + after);
          return after !== before || after > 0;
        };

        var lbl = findSelectAll();
        if (!lbl) { log('  ⚠ 没找到左下角「全选」', 'err'); return; }
        var ok1 = await doSelectAll(lbl);
        log(ok1 ? '  ✓ 第 1 页已全选' : '  ⚠ 第 1 页全选可能没生效', ok1 ? 'ok' : 'err');

        // 翻到第 2 页
        var page2 = null;
        var lis = d.querySelectorAll('.el-pager li, .el-pagination li, .el-pager span, .el-pagination span');
        for (var p = 0; p < lis.length; p++) {
          if (!visible(lis[p])) continue;
          if ((lis[p].textContent || '').trim() === '2') { page2 = lis[p]; break; }
        }
        if (page2) {
          forceClickOne(page2);
          log('  ✓ 已翻到第 2 页', 'ok');
          await sleep(2800);
          var lbl2 = findSelectAll();
          var ok2 = await doSelectAll(lbl2);
          log(ok2 ? '  ✓ 第 2 页已全选' : '  ⚠ 第 2 页全选可能没生效', ok2 ? 'ok' : 'err');
        } else {
          log('  ⚠ 没找到第 2 页（可能只有一页）', 'info');
        }

        log('  最终已选素材数：' + readSelectedCount(d), 'ok');
    }},

    // 19. 素材库提交
    { label: '素材库 - 提交', fn: async function (ctx) {
        var d = getMaterialDialog();
        if (!d) { log('  · 素材库已关闭，跳过', 'info'); return; }
        var btn = findDialogButton(d, ['提交', '确定']);
        if (!btn) throw new Error('素材库没有可点的「提交」');
        forceClickOne(btn);
        var closed = await waitFor(function () { return !getMaterialDialog(); }, 10000, 350);
        if (!closed) throw new Error('点了「提交」但素材库没关闭');
        log('  ✓ 素材已提交', 'ok');
        await sleep(1500);
    }},

    // 20. 乱序 3 次（素材抽屉工具条）
    { label: '乱序 3 次', fn: async function (ctx) {
        var dr = getCreativeDrawer();
        if (!dr) throw new Error('素材抽屉不见了（乱序按钮在抽屉里）');

        // 提交素材后抽屉还在「素材化配置中」，必须等它算完再乱序，否则点了等于没点
        var isBusy = function () {
          var t = (dr.textContent || '');
          if (t.indexOf('素材化配置中') >= 0) return true;
          if (t.indexOf('资源加载中') >= 0) return true;
          var lds = dr.querySelectorAll('.el-loading-mask, .is-loading, .el-loading-spinner');
          for (var i = 0; i < lds.length; i++) {
            if (visible(lds[i])) return true;
          }
          return false;
        };

        if (isBusy()) log('  · 素材还在配置中，等待校验完成…');
        var done = await waitFor(function () { return !isBusy(); }, 40000, 500);
        log('  · 素材配置' + (done ? '已完成' : '等待超时（继续尝试）'));
        await sleep(1500);

        // 等「乱序」按钮可用
        var el = null;
        for (var w = 0; w < 20; w++) {
          var list = dr.querySelectorAll('button, [role="button"], span, div, i');
          for (var i2 = 0; i2 < list.length; i2++) {
            if (!visible(list[i2]) || isDisabled(list[i2])) continue;
            if ((list[i2].textContent || '').replace(/\s+/g, '') === '乱序') { el = list[i2]; break; }
          }
          if (el) break;
          await sleep(500);
        }
        if (!el) throw new Error('素材抽屉里没找到可点的「乱序」');

        for (var k = 0; k < 3; k++) {
          forceClickOne(el);
          log('  · 第 ' + (k + 1) + ' 次乱序');
          await sleep(1500);
        }
        await sleep(1000);
        log('  ✓ 乱序 3 次', 'ok');
    }},

    // 21. 素材抽屉确定
    { label: '素材配置 - 确定', fn: async function (ctx) {
        var dr = getCreativeDrawer();
        if (!dr) { log('  · 素材抽屉已关闭，跳过', 'info'); return; }
        var btn = findDialogButton(dr, ['确定', '保存']);
        if (!btn) throw new Error('素材抽屉没有可点的「确定」');
        forceClickOne(btn);
        var closed = await waitFor(function () { return !getCreativeDrawer(); }, 10000, 350);
        if (!closed) throw new Error('点了「确定」但素材抽屉没关闭');
        log('  ✓ 素材配置已确定', 'ok');
        await sleep(1500);
    }},

    // 20. 落地页：按账户分配，每个账户选各自短剧的落地页
    { label: '落地页（按账户）', fn: async function (ctx) {
        var dramas = ctxDramas(ctx);
        var dr = getLandingDrawer();
        if (!dr) {
          var el = clickColumnAction('落地页', '添加');
          if (!el) el = findAndClick('添加', { exact: true });
          if (!el) throw new Error('没找到落地页「添加」');
          var opened = await waitFor(function () { return !!getLandingDrawer(); }, 8000, 300);
          if (!opened) throw new Error('点了落地页「添加」但选择窗口没出现');
          log('  ✓ 落地页选择窗口已打开', 'ok');
          await sleep(1000);
          dr = getLandingDrawer();
        }

        var uniL = ctxUnified(ctx);
        // 启用了售卖策略 → 落地页一律「按账户分配」：
        // 同名落地页可能分属不同账户，「统一配置」会把同一条挂给所有账户（直接挂错）
        var splitL = landingSplitNeeded(ctx);
        var targetsL = splitL ? ctx.accounts : [ctx.accounts[0]];

        if (ctx.accounts.length > 1) {
          var okRule = await activateChoice(dr, splitL ? ['按账户分配', '分配到账户'] : ['统一配置']);
          if (!okRule) {
            throw new Error(splitL
              ? '落地页抽屉里没找到「按账户分配」，请手动切过去后点面板「继续」'
              : '落地页抽屉里没找到「统一配置」，请手动切过去后点面板「继续」');
          }
          await confirmTipIfAny();
          await sleep(2200);
          dr = getLandingDrawer() || dr;

          if (!splitL) {
            log('  · 分配规则：统一配置（统一模式，不切账户）', 'ok');
          } else {
            // 校验真的切到了「按账户分配」：这个模式下左侧一定有逐个账户的列表。
            // 如果还停在「统一配置」，左侧没有账户列表，选一条会套给所有账户（挂错落地页）
            var missing = [];
            var tLp = Date.now();
            while (Date.now() - tLp < 6000) {
              dr = getLandingDrawer() || dr;
              missing = [];
              for (var vc = 0; vc < ctx.accounts.length; vc++) {
                if (!findAccountNode(dr, ctx.accounts[vc]) && !findAccountNode(document, ctx.accounts[vc])) {
                  missing.push(ctx.accounts[vc]);
                }
              }
              if (!missing.length) break;
              await sleep(400);
            }
            if (missing.length) {
              throw new Error('落地页看起来还在「统一配置」模式（左侧找不到账户 ' + missing.join('/') +
                              '），请手动点「按账户分配」后点面板「继续」');
            }
            log('  · 分配规则：按账户分配（' +
                (uniL ? '已启用售卖策略，统一模式也按账户' : '左侧 ' + ctx.accounts.length + ' 个账户都在') + '）', 'ok');
          }
        }

        for (var ai = 0; ai < targetsL.length; ai++) {
          var acc = targetsL[ai];
          var lp = dramas[ai];
          if (!splitL) {
            log('  【统一】' + targetsL.join(' / ') + ' 共用 → 「' + lp + '」');
          } else {
            log('  【' + (ai + 1) + '/' + targetsL.length + '】账户 ' + acc + ' → 「' + lp + '」');
          }

          dr = getLandingDrawer();
          if (!dr) throw new Error('落地页窗口不见了');

          if (splitL && ctx.accounts.length > 1) {
            var okAccL = await clickAccountRow(dr, acc);
            if (!okAccL) throw new Error('落地页左侧没找到账户 ' + acc);
            dr = getLandingDrawer();
            if (!dr) throw new Error('落地页窗口不见了（切换账户后）');
          }

          await pickLandingFor(dr, lp, splitL ? acc : '', splitL ? ctx.accounts : null);
          await sleep(600);
        }

        var okBtn = findDialogButton(dr, ['确定']);
        if (!okBtn) throw new Error('落地页「确定」不可点（可能没勾选落地页）');
        forceClickOne(okBtn);
        var closed = await waitFor(function () { return !getLandingDrawer(); }, 8000, 300);
        if (!closed) throw new Error('点了「确定」但落地页窗口没关闭');
        log('  ✓ 落地页已确定（' + ctx.accounts.length + ' 个账户）', 'ok');
        await sleep(1500);
    }},

    // 21. 切「统一配置」→ 搜剧名 → 勾选（多账户必须统一配置才能一次选中）
    { label: '落地页 - 统一配置并选落地页', fn: async function (ctx) {
        var dr = getLandingDrawer();
        if (!dr) throw new Error('落地页选择窗口不见了');

        // 1) 分配规则切到「统一配置」
        var uni = null;
        var radios = dr.querySelectorAll('label.el-radio-button');
        for (var i = 0; i < radios.length; i++) {
          if (!visible(radios[i])) continue;
          if ((radios[i].textContent || '').replace(/\s+/g, '').indexOf('统一配置') >= 0) { uni = radios[i]; break; }
        }
        if (uni) {
          if (String(uni.className || '').indexOf('is-active') >= 0) {
            log('  · 分配规则已是「统一配置」');
          } else {
            forceClickOne(uni);
            log('  ✓ 分配规则已切到「统一配置」', 'ok');
            await sleep(2000);
          }
        } else {
          log('  ⚠ 没找到「统一配置」，按当前规则继续', 'info');
        }

        // 2) 搜索剧名（这个搜索框也必须逐字符输入）
        var inp = null;
        var ins = dr.querySelectorAll('input');
        for (var j = 0; j < ins.length; j++) {
          if (!visible(ins[j])) continue;
          if ((ins[j].placeholder || '').indexOf('关键词') >= 0) { inp = ins[j]; break; }
        }
        if (!inp) {
          for (var j2 = 0; j2 < ins.length; j2++) {
            if (!visible(ins[j2])) continue;
            if (ins[j2].type === 'checkbox' || ins[j2].type === 'radio') continue;
            if (ins[j2].readOnly) continue;
            inp = ins[j2]; break;
          }
        }
        if (!inp) throw new Error('没找到落地页搜索框');

        forceClickOne(inp);
        await sleep(600);
        try {
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, '');
        } catch (e) { try { inp.value = ''; } catch (e2) {} }
        inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
        await sleep(300);

        var lp = ctx.landing || ctx.drama;
        await typeChars(inp, lp);
        await sleep(800);
        try {
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        } catch (e) {}
        commitSearch(inp);
        await sleep(3000);

        // 3) 勾选命中的那一行（整行是 label.el-checkbox）
        var pick = null;
        var key = normText(ctx.landing || ctx.drama);
        var rows = dr.querySelectorAll('.list-checkbox-container label.el-checkbox, label.el-checkbox');
        for (var k = 0; k < rows.length; k++) {
          var row = rows[k];
          if (!visible(row)) continue;
          var t = normText(row.textContent);
          if (t.indexOf(key) < 0) continue;
          if (String(row.className || '').indexOf('is-disabled') >= 0) {
            log('  ⚠ 命中的落地页是「已使用」状态、不可勾选：' + (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), 'err');
            continue;
          }
          pick = row; break;
        }
        if (!pick) {
          var cnt = dr.querySelectorAll('label.el-checkbox').length;
          throw new Error('落地页列表里没有可选的「' + (ctx.landing || ctx.drama) + '」（列表 ' + cnt + ' 项，命中的可能都是已使用状态）');
        }
        await clickLabelCheckbox(pick);
        log('  ✓ 已选中落地页：' + (pick.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), 'ok');
        await sleep(800);
    }},

    // 22. 落地页抽屉确定
    { label: '落地页弹窗 - 确定', fn: async function (ctx) {
        var dr = getLandingDrawer();
        if (!dr) { log('  · 落地页窗口已关闭，跳过', 'info'); return; }
        var btn = findDialogButton(dr, ['确定']);
        if (!btn) throw new Error('落地页「确定」不可点（可能没勾选落地页）');
        forceClickOne(btn);
        var closed = await waitFor(function () { return !getLandingDrawer(); }, 8000, 300);
        if (!closed) throw new Error('点了「确定」但落地页窗口没关闭');
        log('  ✓ 落地页已确定', 'ok');
        await sleep(1500);
    }},

    // 23. 生成预览广告
    { label: '生成预览广告（不提交审核）', fn: async function (ctx) {
        var el = findAndClick('生成预览广告', { exact: true }) ||
                 findAndClick('生成预览', { exact: false });
        if (!el) throw new Error('没找到「生成预览广告」');
        await sleep(3000);
        log('🎉 预览已生成 —— 请人工检查后自己点「提交审核」', 'ok');
    }}
  ];

  // 多账户（一个广告挂 N 个账户）改造后，下面这些「单账户」的老步骤已经合并进
  // 「推广产品（按账户）」「创意素材（按账户）」「落地页（按账户）」，从流程里剔除
  (function dropLegacySteps() {
    var legacy = {
      '素材抽屉 - 清空': 1,
      '批量添加视频': 1,
      '素材库 - 搜索剧名': 1,
      '前 2 页全选': 1,
      '素材库 - 提交': 1,
      '乱序 3 次': 1,
      '素材配置 - 确定': 1,
      '落地页 - 统一配置并选落地页': 1,
      '落地页弹窗 - 确定': 1
    };
    var kept = [];
    for (var i = 0; i < STEPS.length; i++) {
      if (!legacy[STEPS[i].label]) kept.push(STEPS[i]);
    }
    STEPS = kept;
  })();

  /* -------------------- 收起 / 展开 -------------------- */

  function collapseToBall(mode) {
    var panel = document.getElementById('mb5-panel');
    var ball = document.getElementById('mb5-ball');
    if (panel) panel.classList.add('mb5-minimized');
    if (!ball) return;
    ball.style.display = 'flex';
    ball.classList.remove('mb5-running', 'mb5-done');
    if (mode === 'done') {
      ball.classList.add('mb5-done');
      ball.textContent = '✓';
      ball.title = '执行完成 · 点击查看日志';
    } else {
      ball.classList.add('mb5-running');
      ball.textContent = '投';
      ball.title = '正在执行 · 点击查看';
    }
  }

  /** 日志滚到最底部（默认看最新） */
  function scrollLogsToBottom() {
    setTimeout(function () {
      var lg = document.getElementById('mb5-logs');
      if (lg) lg.scrollTop = lg.scrollHeight;
    }, 30);
  }

  function expandFromBall() {
    var panel = document.getElementById('mb5-panel');
    var ball = document.getElementById('mb5-ball');
    if (ball) {
      ball.style.display = 'none';
      ball.classList.remove('mb5-running', 'mb5-done');
      ball.textContent = '投';
      ball.title = '创量投放 · 点击展开';
    }
    if (panel) panel.classList.remove('mb5-minimized', 'mb5-hidden');
    updateStatus();
    scrollLogsToBottom();
  }

  /** 执行完成后清空账户和剧名，方便下一次输入 */
  function clearInputs() {
    var a = document.getElementById('mb5-accounts');
    var b = document.getElementById('mb5-drama');
    var p = document.getElementById('mb5-pair');
    if (a) a.value = '';
    if (b) b.value = '';
    if (p) p.value = '';
    var al = document.getElementById('mb5-acc-list');
    var dl = document.getElementById('mb5-drama-list');
    if (al) al.value = '';
    if (dl) dl.value = '';
    try { chrome.storage.local.remove(['lastAccounts', 'lastDrama', 'lastPair', 'lastAccList', 'lastDramaList']); } catch (e) {}
  }

  /* -------------------- XLSX 解析（无依赖） -------------------- */

  function u8FromB64(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /** 读取 zip 中央目录，返回 {文件名: {data, method}} */
  function readZip(u8) {
    var out = {};
    var eocd = -1;
    for (var i = u8.length - 22; i >= 0 && i > u8.length - 70000; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) return out;
    var dv = new DataView(u8.buffer);
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true);
      var compSize = dv.getUint32(off + 20, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var cmtLen = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = '';
      for (var k = 0; k < nameLen; k++) name += String.fromCharCode(u8[off + 46 + k]);
      if (dv.getUint32(lho, true) === 0x04034b50) {
        var lnLen = dv.getUint16(lho + 26, true);
        var leLen = dv.getUint16(lho + 28, true);
        var dStart = lho + 30 + lnLen + leLen;
        out[name] = { data: u8.subarray(dStart, dStart + compSize), method: method };
      }
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  async function inflateEntry(entry) {
    if (!entry) return '';
    if (entry.method === 0) return new TextDecoder('utf-8').decode(entry.data);
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([entry.data]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8').decode(new Uint8Array(ab));
  }

  function xmlDecode(s) {
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** 数字规范化：8.0 → 8，3 → 3，6.90 → 6.9 */
  function normNum(v) {
    var s = String(v == null ? '' : v).replace(/[^\d.]/g, '');
    if (!s) return '';
    var n = parseFloat(s);
    if (isNaN(n)) return '';
    return String(n);
  }

  /**
   * 账号行 → 选策略用的描述
   * names[0] 是按平台命名规则「起充集数-单集价格-最低充值档位」推出来的名字，
   * 名称列（B）只作兜底；mismatch 表示两者不一致
   */
  function specOf(row) {
    var ep = normNum(row && row.startEpisodes);
    var price = normNum(row && row.unitPrice);
    var recharge = normNum(row && row.minRecharge);
    var derived = (ep && price && recharge) ? (ep + '-' + price + '-' + recharge) : '';
    var nm = String((row && row.strategy) || '').trim();
    var names = [];
    if (derived) names.push(derived);
    if (nm && names.indexOf(nm) < 0) names.push(nm);
    return {
      ep: ep, price: price, recharge: recharge,
      names: names,
      mismatch: !!(derived && nm && derived !== nm)
    };
  }

  /** 名称命中：优先整词相等（避免「1-3-6.9」误命中「11-3-6.9」） */
  function nameHit(txt, name) {
    if (!name) return false;
    var toks = String(txt || '').split(/[\s,，、/]+/);
    for (var tk = 0; tk < toks.length; tk++) {
      if (toks[tk] === name) return true;
    }
    var idx = String(txt || '').indexOf(name);
    while (idx >= 0) {
      var prev = idx > 0 ? txt.charAt(idx - 1) : '';
      if (!/\d/.test(prev)) return true;
      idx = String(txt).indexOf(name, idx + 1);
    }
    return false;
  }

  /**
   * 以「起充集数所在行」为准：
   * 行的单元格里出现同样的起充集数 / 单集价格 / 最低充值档位就算命中
   */
  function specMatchCells(cells, spec) {
    if (!spec || !spec.ep || !cells || !cells.length) return false;

    // 1) 按列位置：先找到名字所在格，后面依次是 起充集数 / 单集价格 / 最低档位
    if (spec.names && spec.names.length) {
      for (var ni = 0; ni < spec.names.length; ni++) {
        for (var ci = 0; ci < cells.length; ci++) {
          if (cells[ci] !== spec.names[ni]) continue;
          var ep1 = normNum(cells[ci + 1]);
          var pr1 = normNum(cells[ci + 2]);
          var rc1 = normNum(cells[ci + 3]);
          if (ep1 === spec.ep &&
              (!spec.price || pr1 === spec.price) &&
              (!spec.recharge || rc1 === spec.recharge)) return true;
        }
      }
    }

    // 2) 无序匹配：这一行里同时出现这几个数字（名字格本身不算）
    var hasEp = false, hasPrice = false, hasRecharge = false;
    for (var i = 0; i < cells.length; i++) {
      var cellTxt = cells[i];
      var isNameCell = false;
      if (spec.names) {
        for (var q = 0; q < spec.names.length; q++) if (cellTxt === spec.names[q]) isNameCell = true;
      }
      if (isNameCell) continue;
      var v = normNum(cellTxt);
      if (!v) continue;
      if (v === spec.ep) hasEp = true;
      if (spec.price && v === spec.price) hasPrice = true;
      if (spec.recharge && v === spec.recharge) hasRecharge = true;
    }
    if (!hasEp) return false;
    if (spec.price && !hasPrice) return false;
    if (spec.recharge && !hasRecharge) return false;
    return true;
  }

  /** 按表头文字猜每一列（短剧名列是可选的，加了就按「账户+短剧名」区分策略） */
  function guessStrategyColumns(rows) {
    for (var r = 0; r < Math.min(rows.length, 10); r++) {
      var cells = rows[r];
      var cols = {};
      for (var k in cells) {
        if (!Object.prototype.hasOwnProperty.call(cells, k)) continue;
        var t = String(cells[k] || '').replace(/\s+/g, '');
        if (!t) continue;
        if (!cols.account && /媒体账户|账户ID|账户id|^账户$/.test(t)) cols.account = k;
        else if (!cols.strategy && /策略名称/.test(t)) cols.strategy = k;
        else if (!cols.ep && /起充/.test(t)) cols.ep = k;
        else if (!cols.price && /单集价格|价格/.test(t)) cols.price = k;
        else if (!cols.recharge && /最低充值|充值档位/.test(t)) cols.recharge = k;
        else if (!cols.drama && /短剧|剧名|广告名|创意名|商品名/.test(t) && !/策略|账户/.test(t)) cols.drama = k;
      }
      if (cols.account && cols.strategy) {
        cols.headerRow = r;
        return cols;
      }
    }
    return { account: 'A', strategy: 'B', ep: 'C', price: 'D', recharge: 'E', headerRow: -1 };
  }

  /**
   * 解析售卖策略 xlsx
   * 返回 { rows: [{account, strategy, startEpisodes, unitPrice, minRecharge, drama}], dramaCol }
   * dramaCol 非空 = 表里有「短剧名」列（用来区分同一账户的多条策略）
   */
  async function parseStrategyFile(b64) {
    var zip = readZip(u8FromB64(b64));
    var sharedXml = await inflateEntry(zip['xl/sharedStrings.xml']);
    var sheetXml = await inflateEntry(zip['xl/worksheets/sheet1.xml']);

    var shared = [];
    var siParts = sharedXml.split('</si>');
    for (var sp = 0; sp < siParts.length - 1; sp++) {
      var seg = siParts[sp];
      var cut = seg.indexOf('<si>');
      if (cut >= 0) seg = seg.slice(cut + 4);
      var tRe = /<t[^>]*>([\s\S]*?)<\/t>/g, t, s = '';
      while ((t = tRe.exec(seg))) s += xmlDecode(t[1]);
      shared.push(s);
    }

    var rows = [];
    var rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g, rm;
    while ((rm = rowRe.exec(sheetXml))) {
      var cells = {};
      // 兼容自闭合单元格 <c r="B1" s="2"/>
      var cRe = /<c\s+r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cRe.exec(rm[1]))) {
        var col = cm[1];
        var attrs = cm[2] || '';
        var body = cm[3] || '';
        var vM = body.match(/<v>([\s\S]*?)<\/v>/);
        var iM = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        var val = '';
        if (attrs.indexOf('t="s"') >= 0 && vM) val = shared[parseInt(vM[1], 10)] || '';
        else if (iM) val = xmlDecode(iM[1]);
        else if (vM) val = xmlDecode(vM[1]);
        cells[col] = String(val).trim();
      }
      rows.push(cells);
    }

    var cols = guessStrategyColumns(rows);
    var map = [];
    for (var r = 0; r < rows.length; r++) {
      if (r <= cols.headerRow) continue;
      var acc = String(rows[r][cols.account] || '').replace(/\s+/g, '');
      var name = rows[r][cols.strategy] || '';
      if (!/^\d{6,}$/.test(acc)) continue;      // 只认账户ID行
      if (!name || name.indexOf('策略名称') >= 0) continue;
      map.push({
        account: acc,
        strategy: name,
        startEpisodes: rows[r][cols.ep] || '',
        unitPrice: rows[r][cols.price] || '',
        minRecharge: rows[r][cols.recharge] || '',
        drama: cols.drama ? String(rows[r][cols.drama] || '').trim() : ''
      });
    }
    return { rows: map, dramaCol: cols.drama || '' };
  }

  async function parseStrategyXlsx(b64) {
    return (await parseStrategyFile(b64)).rows;
  }

  /**
   * 表格行 → 索引
   * 有「短剧名」列 → 按 账户|短剧名 精确取；
   * 没有 → 退回按账户取（同一账户多条不同策略会被标记为 ambiguous）
   */
  function buildSpecIndex(rows) {
    var byAccDrama = {}, byAcc = {}, seen = {}, ambiguous = [];
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i];
      var sp = specOf(m);
      var dk = normText(m.drama || '');
      if (dk) byAccDrama[m.account + '|' + dk] = sp;
      byAcc[m.account] = sp;
      var key = sp.ep + '|' + sp.price + '|' + sp.recharge;
      if (!seen[m.account]) seen[m.account] = {};
      seen[m.account][key] = true;
    }
    for (var a in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, a)) continue;
      if (Object.keys(seen[a]).length > 1) ambiguous.push(a);
    }
    return {
      byAccDrama: byAccDrama,
      byAcc: byAcc,
      ambiguous: ambiguous,
      hasDrama: Object.keys(byAccDrama).length > 0
    };
  }

  /**
   * 取某账户 + 某部剧对应的策略
   * 返回 { spec, match }；match = drama / drama~ / acc / acc-ambiguous
   */
  function specFor(idx, acc, drama) {
    if (!idx) return null;
    var dk = normText(drama || '');
    if (dk && idx.byAccDrama[acc + '|' + dk]) {
      return { spec: idx.byAccDrama[acc + '|' + dk], match: 'drama' };
    }
    if (dk) {
      for (var k in idx.byAccDrama) {
        if (!Object.prototype.hasOwnProperty.call(idx.byAccDrama, k)) continue;
        var p = k.split('|');
        if (p[0] !== acc || !p[1]) continue;
        if (p[1].indexOf(dk) >= 0 || dk.indexOf(p[1]) >= 0) {
          return { spec: idx.byAccDrama[k], match: 'drama~' };
        }
      }
    }
    if (idx.byAcc[acc]) {
      return {
        spec: idx.byAcc[acc],
        match: idx.ambiguous.indexOf(acc) >= 0 ? 'acc-ambiguous' : 'acc'
      };
    }
    return null;
  }

  /* ---- 极简 ZIP 写入：只用于把「短剧名」列从上上传文件里删掉（存储方式，不压缩） ---- */
  var CRC_TABLE = null;
  function crc32(u8) {
    if (!CRC_TABLE) {
      CRC_TABLE = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(entries) {
    var enc = new TextEncoder();
    var w2 = function (arr, v) { arr.push(v & 255, (v >>> 8) & 255); };
    var w4 = function (arr, v) { arr.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
    var locals = [], centrals = [], offset = 0;
    for (var i = 0; i < entries.length; i++) {
      var nb = enc.encode(entries[i].name);
      var data = entries[i].data;
      var crc = crc32(data);
      var lh = [0x50, 0x4b, 0x03, 0x04];
      w2(lh, 10); w2(lh, 0); w2(lh, 0); w2(lh, 0); w2(lh, 0);
      w4(lh, crc); w4(lh, data.length); w4(lh, data.length);
      w2(lh, nb.length); w2(lh, 0);
      locals.push(new Uint8Array(lh), nb, data);
      var ch = [0x50, 0x4b, 0x01, 0x02];
      w2(ch, 10); w2(ch, 10); w2(ch, 0); w2(ch, 0); w2(ch, 0); w2(ch, 0);
      w4(ch, crc); w4(ch, data.length); w4(ch, data.length);
      w2(ch, nb.length); w2(ch, 0); w2(ch, 0); w2(ch, 0); w2(ch, 0);
      w4(ch, 0); w4(ch, offset);
      centrals.push(new Uint8Array(ch), nb);
      offset += lh.length + nb.length + data.length;
    }
    var cSize = 0;
    for (var c2 = 0; c2 < centrals.length; c2++) cSize += centrals[c2].length;
    var eocd = [0x50, 0x4b, 0x05, 0x06];
    w2(eocd, 0); w2(eocd, 0);
    w2(eocd, entries.length); w2(eocd, entries.length);
    w4(eocd, cSize); w4(eocd, offset); w2(eocd, 0);
    var all = locals.concat(centrals, [new Uint8Array(eocd)]);
    var total = 0;
    for (var a = 0; a < all.length; a++) total += all[a].length;
    var out = new Uint8Array(total), p = 0;
    for (var b = 0; b < all.length; b++) { out.set(all[b], p); p += all[b].length; }
    return out;
  }

  function b64FromU8(u8) {
    var s = '';
    var chunk = 0x8000;
    for (var i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  /** 从 xlsx 里删掉某一整列（「短剧名」列），让上传文件仍是平台要求的 5 列模板 */
  async function stripStrategyColumn(b64, colLetter) {
    if (!colLetter) return b64;
    var zip = readZip(u8FromB64(b64));
    var sheet = zip['xl/worksheets/sheet1.xml'];
    if (!sheet) throw new Error('xlsx 里没有 sheet1.xml');
    var xml = (sheet.method === 0)
      ? new TextDecoder('utf-8').decode(sheet.data)
      : await inflateEntry(sheet);
    var re = new RegExp('<c r="' + colLetter + '\\d+"[^>]*?(?:/>|>[\\s\\S]*?</c>)', 'g');
    var after = xml.replace(re, '');
    if (after === xml) throw new Error('没删到「' + colLetter + '」列');

    var entries = [];
    for (var name in zip) {
      if (!Object.prototype.hasOwnProperty.call(zip, name)) continue;
      var data;
      if (name === 'xl/worksheets/sheet1.xml') {
        data = new TextEncoder().encode(after);
      } else if (zip[name].method === 0) {
        data = zip[name].data;
      } else {
        data = new TextEncoder().encode(await inflateEntry(zip[name]));
      }
      entries.push({ name: name, data: data });
    }
    return b64FromU8(buildZip(entries));
  }

  /* -------------------- 主循环 -------------------- */

  async function run(payload) {
    var ctx = {
      accounts: payload.accounts || [],
      dramas: payload.dramas || null,          // 与 accounts 一一对应（每个账户一部剧）
      byAccount: payload.byAccount === true,   // 面板选的是「多账户/分账户」→ 一律按账户逐个设置
      drama: payload.drama || '',
      landing: payload.landing || payload.drama || '',
      library: payload.library || '',
      copyTemplate: payload.copyTemplate !== false,
      strategy: payload.strategy || null,
      materialFolder: payload.materialFolder || '',
      queueInfo: payload.queueInfo || null
    };
    if (!ctx.accounts.length) {
      log('⚠ 启动失败：没有账户 ID', 'err');
      setStep('⚠ 启动参数不完整');
      return false;
    }
    if (!ctx.library || !ctx.materialFolder) {
      log('⚠ 启动失败：商品库和素材目录都必须填写', 'err');
      setStep('⚠ 请填写商品库与素材目录');
      return false;
    }
    STATE.running = true; STATE.paused = false; STATE.stopped = false;
    STATE.failedStep = -1; STATE.stepIndex = 0; STATE.logs = [];
    var logsEl = document.getElementById('mb5-logs');
    if (logsEl) logsEl.innerHTML = '';
    updateStatus();

    if (ctx.queueInfo) {
      log('🔄 分批进度：第 ' + (ctx.queueInfo.index + 1) + '/' + ctx.queueInfo.total + ' 个账户');
    }
    log('版本 ' + BUILD);
    log('🚀 开始：账户 ' + ctx.accounts.join(' / ') + '，商品库「' + ctx.library + '」');
    var dmap = ctxDramas(ctx);
    for (var dm = 0; dm < ctx.accounts.length; dm++) {
      log('   ' + ctx.accounts[dm] + ' → 「' + dmap[dm] + '」');
    }
    // 执行方式只看面板选的页签，不再因为短剧名相同就自动切成统一模式
    log('执行方式：' + (ctx.byAccount
      ? '分账户（' + ctx.accounts.length + ' 个账户逐个设置推广产品 / 素材 / 落地页）'
      : '统一模式（所有账户共用一份）'));

    // 执行过程中收起为悬浮球，给页面留出更多可视空间
    collapseToBall();

    var i = 0;
    while (i < STEPS.length) {
      if (STATE.stopped) break;
      if (STATE.paused) {
        try { await sleep(250); } catch (eP) { break; }   // 暂停中点了停止 → 立刻退出
        continue;
      }

      STATE.stepIndex = i; STATE.failedStep = -1;
      setStep('[' + (i + 1) + '/' + STEPS.length + '] ' + STEPS[i].label);
      log('▶ ' + STEPS[i].label);

      try {
        await STEPS[i].fn(ctx);
        log('  ✓ 完成', 'ok');
        i++;
      } catch (e) {
        // 点了「停止」：不当作失败，直接中断整条流程
        if (STATE.stopped || (e && e.message === '__MB_STOPPED__')) break;

        log('  ✗ ' + e.message, 'err');
        // 失败时把当前页面状态打出来，方便快速定位
        try {
          var d = getVisibleDialog();
          if (d) {
            var te = d.querySelector('.el-dialog__title');
            log('  诊断·当前弹窗：' + (te ? (te.textContent || '').trim() : '') +
                ' | 按钮：' + collectDialogButtons(d) +
                ' | 文字：' + (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), 'err');
          } else {
            log('  诊断·当前没有弹窗', 'err');
          }
          var acts = [];
          var list = document.querySelectorAll('button');
          for (var bi2 = 0; bi2 < list.length && acts.length < 14; bi2++) {
            if (!visible(list[bi2])) continue;
            var bt = (list[bi2].textContent || '').replace(/\s+/g, '').trim();
            if (bt && bt.length <= 8) acts.push(bt);
          }
          log('  诊断·页面可见按钮：' + acts.join('/'), 'err');
        } catch (de) {}
        STATE.failedStep = i; STATE.paused = true;
        setStep('❌ 第 ' + (i + 1) + ' 步失败（可点「继续」重试）');
        updateStatus();
        expandFromBall();   // 出错时展开面板，方便看日志
      }
      if (!STATE.stopped) { try { await sleep(400); } catch (eS) { break; } }
    }

    if (!STATE.stopped) {
      log('✅ 全部步骤完成，停在「生成预览」，未提交审核', 'ok');
      setStep('✅ 全部完成');

      // 分批模式：还有下一个账户 → 刷新页面自动继续
      if (STATE.queue && STATE.queueIndex + 1 < STATE.queue.length) {
        STATE.queueIndex++;
        saveQueue(STATE.queueIndex);
        STATE.running = false; STATE.paused = false;
        updateStatus();
        collapseToBall('done');
        log('✅ 第 ' + STATE.queueIndex + '/' + STATE.queue.length + ' 个账户完成，2 秒后刷新页面继续下一个…', 'ok');
        setTimeout(function () { location.reload(); }, 2000);
        return;
      }

      if (STATE.queue) {
        log('🎉 分批任务全部完成（共 ' + STATE.queue.length + ' 个账户）', 'ok');
        clearQueue();
      }

      clearInputs();      // 清空账户/剧名，方便下次输入
      log('已清空输入框，可以开始下一轮', 'ok');
      STATE.running = false; STATE.paused = false;
      updateStatus();
      // 不展开面板，改成绿色 ✓ 悬浮球，避免挡住视野
      collapseToBall('done');
      return;
    }

    log('■ 已停止', 'err');
    setStep('■ 已停止');
    clearQueue();
    STATE.running = false; STATE.paused = false;
    updateStatus();
    expandFromBall();
  }

  /* -------------------- 浅色面板（可拖拽 + 可收起） -------------------- */

  function injectPanel() {
    if (document.getElementById('mb5-panel')) return;

    var css = [
      '@keyframes mb5Pulse{0%{box-shadow:0 0 0 0 rgba(31,41,55,.28)}70%{box-shadow:0 0 0 10px rgba(31,41,55,0)}100%{box-shadow:0 0 0 0 rgba(31,41,55,0)}}',
      '#mb5-panel{position:fixed;right:20px;bottom:20px;width:300px;z-index:2147483646;',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;',
      'background:#fff;border:1px solid #ECEEF2;border-radius:14px;',
      'box-shadow:0 12px 32px rgba(17,24,39,.10),0 2px 6px rgba(17,24,39,.04);',
      'color:#374151;overflow:hidden;display:flex;flex-direction:column;max-height:480px;user-select:none;',
      'backdrop-filter:blur(6px)}',
      '#mb5-panel.mb5-hidden{display:none}#mb5-panel.mb5-minimized{display:none}',

      '#mb5-header{padding:10px 12px;background:linear-gradient(180deg,#FCFDFE 0%,#F5F7FA 100%);cursor:move;',
      'display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:#374151;',
      'font-weight:600;letter-spacing:.2px;border-bottom:1px solid #EEF1F5;user-select:none}',
      // 标题过长时只省略文字，绝不把右边「复制 / — / ×」挤出去
      '#mb5-header .mb5-ttl{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '#mb5-header .mb5-ver{display:block;margin-top:2px;font-size:9.5px;font-weight:400;',
      'color:#9AA3B2;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#mb5-header .mb5-btns{display:flex;gap:4px;align-items:center;flex-shrink:0;margin-left:6px}',
      '#mb5-header .mb5-btns a{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;',
      'padding:0 5px;border-radius:6px;color:#8A93A3;cursor:pointer;font-size:13px;line-height:1;white-space:nowrap;',
      'transition:background .15s,color .15s}',
      '#mb5-header .mb5-btns a:hover{background:#E9EDF3;color:#1F2937}',

      '#mb5-body{padding:10px 12px 4px;overflow-y:auto;flex:1}',
      '#mb5-body .mb5-field{margin-bottom:8px}',
      '#mb5-body label{display:block;font-size:10px;color:#7B8494;margin-bottom:4px;letter-spacing:.2px}',
      '#mb5-body textarea,#mb5-body input[type=text]{width:100%;box-sizing:border-box;',
      'border:1px solid #E4E8EE;border-radius:8px;padding:6px 8px;font-size:11.5px;color:#1F2937;',
      'font-family:inherit;outline:none;background:#fff;transition:border-color .15s,box-shadow .15s}',
      '#mb5-body textarea{height:40px;resize:vertical}',
      '#mb5-body textarea#mb5-pair{height:52px;resize:vertical}',
      '#mb5-body .mb5-file{display:flex;align-items:center;gap:6px;margin-top:2px}',
      '#mb5-body .mb5-file button{height:24px;padding:0 8px;border-radius:6px;border:1px solid #E4E8EE;',
      'background:#fff;font-size:10.5px;color:#374151;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '#mb5-body .mb5-file button:hover{background:#F6F8FA}',
      '#mb5-body .mb5-file .mb5-fname{font-size:10px;color:#8A93A3;overflow:hidden;',
      'text-overflow:ellipsis;white-space:nowrap;flex:1}',
      '#mb5-body .mb5-hint{font-size:9.5px;color:#A7AEBB;margin-top:3px;line-height:1.5}',
      '#mb5-body .mb5-tabs{display:flex;background:#F2F4F7;border-radius:8px;padding:2px;margin-bottom:8px}',
      '#mb5-body .mb5-tabs span{flex:1;text-align:center;font-size:10.5px;padding:4px 0;border-radius:6px;',
      'color:#7B8494;cursor:pointer;transition:background .15s,color .15s}',
      '#mb5-body .mb5-tabs span.on{background:#fff;color:#1F2937;font-weight:600;box-shadow:0 1px 3px rgba(17,24,39,.08)}',
      '#mb5-body .mb5-pane{display:none}',
      '#mb5-body .mb5-pane.on{display:block}',
      '#mb5-body textarea.mb5-list{height:62px;resize:vertical}',
      '#mb5-body textarea::placeholder,#mb5-body input[type=text]::placeholder{color:#B4BBC6}',
      '#mb5-body textarea:focus,#mb5-body input[type=text]:focus{border-color:#A7D7C3;box-shadow:0 0 0 3px rgba(16,163,127,.10)}',
      '#mb5-body .mb5-row{display:flex;align-items:center;gap:6px;margin:2px 0 8px;font-size:10.5px;color:#6B7280;cursor:pointer}',
      '#mb5-body .mb5-row input{accent-color:#2F9E73}',

      '#mb5-body .mb5-step{padding:7px 9px;font-size:11px;font-weight:600;color:#1F2937;',
      'background:#F8FAFB;border:1px solid #EEF1F5;border-radius:8px;margin:2px 0 8px;line-height:1.45}',

      '#mb5-logs{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;line-height:1.62;',
      'max-height:190px;overflow-y:auto;padding:7px 9px;background:#FBFCFD;border:1px solid #F0F2F5;',
      'border-radius:8px;margin-bottom:6px}',
      '#mb5-logs::-webkit-scrollbar{width:6px}',
      '#mb5-logs::-webkit-scrollbar-thumb{background:#E1E5EB;border-radius:6px}',

      '#mb5-footer{padding:8px 12px 10px;border-top:1px solid #F0F2F5;background:#FCFDFE;display:flex;gap:6px}',
      '#mb5-footer button{flex:1;height:30px;border-radius:8px;border:1px solid #E4E8EE;',
      'background:#fff;cursor:pointer;font-size:11.5px;font-family:inherit;color:#374151;',
      'transition:background .15s,border-color .15s,color .15s}',
      '#mb5-footer button:hover:not(:disabled){background:#F6F8FA}',
      '#mb5-footer button.primary{background:#1F2937;border-color:#1F2937;color:#fff;font-weight:600}',
      '#mb5-footer button.primary:hover:not(:disabled){background:#111827}',
      '#mb5-footer button.danger{color:#D9534F;border-color:#F4D7D5}',
      '#mb5-footer button.danger:hover:not(:disabled){background:#FDF3F2}',
      '#mb5-footer button:disabled{opacity:.42;cursor:not-allowed}',

      /* 悬浮球 */
      '#mb5-ball{position:fixed;width:36px;height:36px;border-radius:50%;background:#fff;',
      'border:1px solid #E4E8EE;box-shadow:0 6px 18px rgba(17,24,39,.12);z-index:2147483646;',
      'right:20px;bottom:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'font-size:12px;font-weight:600;color:#4B5563;user-select:none;transition:transform .15s,background .15s,color .15s}',
      '#mb5-ball:hover{transform:scale(1.06);background:#F6F8FA;color:#1F2937}',
      '#mb5-ball.mb5-running{background:#1F2937;color:#fff;border-color:#1F2937;animation:mb5Pulse 2.2s infinite}',
      '#mb5-ball.mb5-done{background:#2F9E73;color:#fff;border-color:#2F9E73;',
      'box-shadow:0 8px 22px rgba(47,158,115,.35);font-size:14px}',
      '#mb5-ball.mb5-done:hover{background:#288a64;color:#fff}'
    ].join('');

    var html = '<style>' + css + '</style>' +
      '<div id="mb5-ball" style="display:none;" title="创量投放 · 点击展开">投</div>' +
      '<div id="mb5-panel">' +
        '<div id="mb5-header">' +
          '<span class="mb5-ttl" title="' + BUILD + '">创量投放助手 <span class="mb5-ver">' + BUILD_SHORT + '</span></span>' +
          '<span class="mb5-btns">' +
            '<a id="mb5-copylog" title="复制全部日志" style="width:auto;padding:0 4px;font-size:11px;">复制</a>' +
            '<a id="mb5-min" title="收起为悬浮球">—</a>' +
            '<a id="mb5-close" title="彻底隐藏">×</a>' +
          '</span>' +
        '</div>' +
        '<div id="mb5-body">' +
          '<div class="mb5-tabs">' +
            '<span id="mb5-tab-u" class="on">统一模式</span>' +
            '<span id="mb5-tab-p">多账户（各自一剧）</span>' +
          '</div>' +
          '<div class="mb5-pane on" id="mb5-pane-u">' +
            '<div class="mb5-field"><label>账户 ID（逗号/空格/换行分隔，最多 4 个）</label>' +
              '<textarea id="mb5-accounts" placeholder="10000001, 10000002"></textarea></div>' +
            '<div class="mb5-field"><label>短剧名（所有账户共用）</label>' +
              '<input type="text" id="mb5-drama" placeholder="示例短剧 A"></div>' +
          '</div>' +
          '<div class="mb5-pane" id="mb5-pane-p">' +
            '<div class="mb5-field"><label>账户 ID（一行一个，直接粘贴）</label>' +
              '<textarea id="mb5-acc-list" class="mb5-list" placeholder="10000001&#10;10000002&#10;10000003"></textarea></div>' +
            '<div class="mb5-field"><label>短剧名（一行一个，按顺序对应）</label>' +
              '<textarea id="mb5-drama-list" class="mb5-list" placeholder="示例短剧 A&#10;示例短剧 B&#10;示例短剧 C"></textarea>' +
              '<div class="mb5-hint">同一个广告里挂这些账户，按行一一对应：第 1 个账户用第 1 个短剧。推广产品/售卖策略/素材/落地页都会按账户分别设置</div></div>' +
          '</div>' +
          '<div class="mb5-field"><label>商品库（需与平台名称一致）</label>' +
            '<input type="text" id="mb5-library" placeholder="例如：示例商品库"></div>' +
          '<div class="mb5-field"><label>素材目录（需与平台名称一致）</label>' +
            '<input type="text" id="mb5-material-folder" placeholder="例如：投手-示例"></div>' +
          '<div class="mb5-row"><input type="checkbox" id="mb5-strategy"> 启用售卖策略（付费短剧）</div>' +
          '<div class="mb5-file"><button id="mb5-pick">选择售卖策略文件</button>' +
            '<span class="mb5-fname" id="mb5-fname">未选择 .xlsx</span>' +
            '<input type="file" id="mb5-file" accept=".xlsx" style="display:none"></div>' +
          '<div class="mb5-row"><input type="checkbox" id="mb5-copy" checked> 自动点「复用」沿用上次模板</div>' +
          '<div class="mb5-step" id="mb5-step">就绪 · ' + BUILD + '</div>' +
          '<div id="mb5-logs"></div>' +
        '</div>' +
        '<div id="mb5-footer">' +
          '<button class="primary" id="mb5-start">▶ 开始</button>' +
          '<button id="mb5-pause" disabled>⏸ 暂停</button>' +
          '<button class="danger" id="mb5-stop" disabled>■ 停止</button>' +
        '</div>' +
      '</div>';

    document.body.insertAdjacentHTML('beforeend', html);

    var panel = document.getElementById('mb5-panel');
    var ball = document.getElementById('mb5-ball');
    if (!panel) return;

    /* --- 拖拽 --- */
    (function drag() {
      var header = document.getElementById('mb5-header');
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      header.addEventListener('mousedown', function (e) {
        if (e.target.id === 'mb5-min' || e.target.id === 'mb5-close') return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        var r = panel.getBoundingClientRect();
        ox = r.left; oy = r.top;
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var nx = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth - 4, ox + e.clientX - sx));
        var ny = Math.max(0, Math.min(window.innerHeight - 20, oy + e.clientY - sy));
        panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
      });
      document.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        // 记住位置
        try {
          chrome.storage.local.set({ mb5Pos: { left: panel.style.left, top: panel.style.top } });
        } catch (e) {}
      });
    })();

    /* --- 悬浮球 --- */
    ball.addEventListener('click', function () {
      expandFromBall();
      // 恢复记住的位置
      try {
        chrome.storage.local.get(['mb5Pos'], function (v) {
          if (v && v.mb5Pos) {
            panel.style.left = v.mb5Pos.left; panel.style.top = v.mb5Pos.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
          }
        });
      } catch (e) {}
      scrollLogsToBottom();
    });

    document.getElementById('mb5-min').addEventListener('click', function () {
      panel.classList.add('mb5-minimized');
      ball.style.display = 'flex';
      // 记住悬浮球也放在用户习惯的位置
      try { chrome.storage.local.set({ mb5Minimized: true }); } catch (e) {}
    });
    document.getElementById('mb5-close').addEventListener('click', function () {
      panel.classList.add('mb5-hidden');
      ball.style.display = 'none';
    });

    /* --- 按钮事件 --- */
    document.getElementById('mb5-start').onclick = function () { startFromPanel(); };

    /* --- 模式切换：统一 / 分账户 --- */
    (function bindTabs() {
      var tu = document.getElementById('mb5-tab-u');
      var tp = document.getElementById('mb5-tab-p');
      var pu = document.getElementById('mb5-pane-u');
      var pp = document.getElementById('mb5-pane-p');
      if (!tu || !tp || !pu || !pp) return;

      function setMode(pair) {
        if (pair) {
          tp.classList.add('on'); tu.classList.remove('on');
          pp.classList.add('on'); pu.classList.remove('on');
        } else {
          tu.classList.add('on'); tp.classList.remove('on');
          pu.classList.add('on'); pp.classList.remove('on');
        }
        try { chrome.storage.local.set({ lastMode: pair ? 'pair' : 'single' }); } catch (e) {}
      }
      tu.addEventListener('click', function () { setMode(false); });
      tp.addEventListener('click', function () { setMode(true); });
      try {
        chrome.storage.local.get(['lastMode'], function (v) {
          if (v && v.lastMode === 'pair') setMode(true);
        });
      } catch (e) {}
    })();

    /* --- 售卖策略文件选择 --- */
    (function bindStrategyFile() {
      var pickBtn = document.getElementById('mb5-pick');
      var fileEl = document.getElementById('mb5-file');
      var nameEl = document.getElementById('mb5-fname');
      if (!pickBtn || !fileEl) return;

      pickBtn.addEventListener('click', function () { fileEl.click(); });

      fileEl.addEventListener('change', function () {
        var f = fileEl.files && fileEl.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var bytes = new Uint8Array(fr.result);
            var bin = '';
            for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            STATE.strategy = { name: f.name, b64: btoa(bin) };
            if (nameEl) nameEl.textContent = f.name;
            document.getElementById('mb5-strategy').checked = true;
            log('已选择售卖策略文件：' + f.name + '（' + bytes.length + ' 字节）', 'ok');
          } catch (e) {
            log('读取文件失败：' + e.message, 'err');
          }
        };
        fr.readAsArrayBuffer(f);
      });
    })();

    document.getElementById('mb5-copylog').addEventListener('click', function () {
      var text = '版本 ' + BUILD + '\n' +
        STATE.logs.map(function (l) { return '[' + l.t + '] ' + l.msg; }).join('\n');
      var ok = false;
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {}
      var self = this;
      this.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () { self.textContent = '复制'; }, 1500);
    });
    var pauseBtn = document.getElementById('mb5-pause');
    pauseBtn.onclick = function () {
      if (!STATE.running) return;
      if (STATE.paused) {
        STATE.paused = false;
        log('▶ 继续执行');
        updateStatus();
        // 恢复执行后立刻收起成悬浮球（接管完成也要藏起来）
        collapseToBall('running');
        return;
      }
      STATE.paused = true;
      log('⏸ 已暂停（再点一次继续）');
      updateStatus();
    };
    document.getElementById('mb5-stop').onclick = function () {
      STATE.stopped = true; STATE.paused = false;
      cancelAllSleeps();     // 立刻打断所有挂起的等待
      log('■ 已停止（正在中断当前操作…）', 'err');
      setStep('■ 已停止');
      // 立刻把按钮切成「可开始」，不用等当前步骤退出
      var st = document.getElementById('mb5-start');
      var pa = document.getElementById('mb5-pause');
      var so = document.getElementById('mb5-stop');
      if (st) st.disabled = false;
      if (pa) pa.disabled = true;
      if (so) so.disabled = true;
      expandFromBall();
    };

    /* --- 恢复上次位置/折叠状态/输入 --- */
    try {
      chrome.storage.local.get(
        ['mb5Pos', 'mb5Minimized', 'lastCopy'],
        function (v) {
          if (v && v.mb5Pos) {
            panel.style.left = v.mb5Pos.left; panel.style.top = v.mb5Pos.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
          }
          if (v && v.mb5Minimized) {
            panel.classList.add('mb5-minimized');
            ball.style.display = 'flex';
          }
          // 输入框不再恢复上次内容（刷新后默认清空）
          if (v && v.lastCopy !== undefined) document.getElementById('mb5-copy').checked = v.lastCopy;
          // (剧名输入框同样不恢复)
          // (账户列/短剧列同样不恢复，统一由 clearInputs 清空)
        }
      );
    } catch (e) {}

    // 打开面板时日志默认停在最新一条
    scrollLogsToBottom();
    setTimeout(scrollLogsToBottom, 300);

    // 刷新后若有未完成的分批任务，自动接着跑
    tryResumeQueue();
  }

  /** 按标题找弹窗（优先精确等于，其次包含） */
  function getDialogByTitle(title) {
    var list = document.querySelectorAll('.el-dialog, .el-drawer, .el-message-box, .cl-dialog, [role="dialog"]');
    var loose = null;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!visible(el)) continue;
      var h = el.querySelector('.el-dialog__title, .el-drawer__title, .el-message-box__title, .el-dialog__header, .el-message-box__header');
      var txt = ((h ? h.textContent : el.textContent) || '').replace(/\s+/g, ' ').trim();
      if (txt === title) return el;
      if (!loose && txt.indexOf(title) >= 0) loose = el;
    }
    return loose;
  }

  /**
   * 「失败详情」弹窗：同一账户重复建同名售卖策略时会弹出。
   * 出现几次关几次（点确认），最多等 maxMs 毫秒；返回关掉的次数。
   */
  async function closeFailDetailDlg(maxMs) {
    var closed = 0;
    var start = Date.now();
    while (Date.now() - start < maxMs) {
      var d = getDialogByTitle('失败详情');
      if (d) {
        var txt = (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        log('  ⚠ 出现「失败详情」弹窗：' + txt, 'err');
        var btn = findDialogButton(d, ['确认', '确定', '知道了', '关闭']);
        if (!btn) {
          var x = d.querySelector('.el-dialog__headerbtn, .el-message-box__headerbtn, .el-dialog__close, .el-icon-close');
          if (x && visible(x)) btn = x;
        }
        if (btn) {
          forceClickOne(btn);
          closed++;
          log('  · 已点「确认」关闭失败详情', 'ok');
        } else {
          log('  ⚠ 失败详情里没找到关闭按钮', 'err');
        }
        await sleep(1200);
      } else if (closed > 0) {
        break;   // 关过了且不再出现
      } else {
        await sleep(400);
      }
    }
    return closed;
  }

  /** 清空策略列表的搜索框（关键词输入框） */
  async function clearStrategySearch(dlg) {
    if (!dlg) return;
    var inputs = dlg.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var ip = inputs[i];
      if (!visible(ip)) continue;
      if (ip.type === 'checkbox' || ip.type === 'radio') continue;
      var ph = ip.placeholder || '';
      if (ph.indexOf('关键词') >= 0 || ph.indexOf('搜索') >= 0 || ph.indexOf('策略') >= 0) {
        setInputValue(ip, '');
        commitSearch(ip);
        var sBtn = dlg.querySelector('.cl-search-input__submit');
        if (sBtn && visible(sBtn)) forceClickOne(sBtn);
        return;
      }
    }
  }

  function startFromPanel() {
    if (STATE.running) { log('⚠ 正在执行中，请先停止', 'err'); return; }

    var raw = (document.getElementById('mb5-accounts').value || '').trim();
    var drama = (document.getElementById('mb5-drama').value || '').trim();
    var pairMode = document.getElementById('mb5-tab-p').classList.contains('on');
    var pairRaw = '';
    var copy = document.getElementById('mb5-copy').checked;
    var useStrategy = document.getElementById('mb5-strategy').checked;
    var library = (document.getElementById('mb5-library').value || '').trim();
    var materialFolder = (document.getElementById('mb5-material-folder').value || '').trim();

    if (useStrategy && !STATE.strategy) {
      log('⚠ 勾了「启用售卖策略」但没选文件', 'err');
      return;
    }
    if (!library) { log('⚠ 请先填写商品库名称', 'err'); return; }
    if (!materialFolder) { log('⚠ 请先填写素材目录名称', 'err'); return; }

    // 分账户映射：每行 账户ID,短剧名（短剧名里可以有逗号）
    var pairs = [];
    var lines = pairRaw.split(/\n+/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;
      var m = line.match(/^([^,，\t]+)[,，\t]([\s\S]+)$/);
      if (!m) continue;
      var acc = m[1].replace(/\s+/g, '');
      var drm = m[2].trim();
      if (acc && drm) pairs.push({ account: acc, drama: drm, landing: drm });
    }

    STATE.opts = {
      copyTemplate: copy,
      strategy: useStrategy ? STATE.strategy : null,
      library: library,
      materialFolder: materialFolder
    };
    try { chrome.storage.local.set({ lastCopy: copy }); } catch (e) {}

    if (pairMode) {
      var accText = document.getElementById('mb5-acc-list').value || '';
      var drmText = document.getElementById('mb5-drama-list').value || '';
      // 不再保存输入内容（刷新后默认清空）

      var accList = splitList(accText);
      var drmList = splitList(drmText);
      if (!accList.length) { log('⚠ 请粘贴账户 ID（一行一个）', 'err'); return; }
      if (!drmList.length) { log('⚠ 请粘贴短剧名（一行一个）', 'err'); return; }
      if (accList.length !== drmList.length) {
        log('⚠ 数量不一致：账户 ' + accList.length + ' 个、短剧 ' + drmList.length + ' 个', 'err');
        log('   账户解析：' + accList.join(' | '), 'err');
        log('   短剧解析：' + drmList.join(' | '), 'err');
        return;
      }
      var preview = '';
      for (var pv = 0; pv < accList.length; pv++) {
        preview += (pv ? '，' : '') + accList[pv] + '→' + drmList[pv];
      }
      log('📦 一个广告挂 ' + accList.length + ' 个账户：' + preview);

      STATE.queue = null;
      try { chrome.storage.local.remove(['mb5Queue']); } catch (e) {}

      run({
        accounts: accList,
        dramas: drmList,
        drama: drmList[0],
        landing: drmList[0],
        byAccount: true,
        copyTemplate: copy,
        strategy: STATE.opts.strategy,
        library: library,
        materialFolder: materialFolder
      });
      return;
    }
    try { chrome.storage.local.set({ lastCopy: copy }); } catch (e) {}

    // ===== 统一模式：一个广告挂 N 个账户，共用一部剧 =====
    if (!raw) { log('⚠ 请先填账户 ID', 'err'); return; }
    if (!drama) { log('⚠ 请先填短剧名（或改用「每账户短剧」）', 'err'); return; }

    var arr = raw.split(/[\s,，;；\/／、|｜]+/);
    var accounts = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i].trim();
      if (v && accounts.indexOf(v) < 0) accounts.push(v);
    }
    if (!accounts.length) { log('⚠ 账户 ID 无效', 'err'); return; }

    STATE.queue = null;
    try { chrome.storage.local.remove(['mb5Queue']); } catch (e) {}
    try { chrome.storage.local.set({ lastCopy: copy }); } catch (e) {}

    run({
      accounts: accounts,
      drama: drama,
      landing: drama,
        byAccount: false,
        copyTemplate: copy,
        strategy: STATE.opts.strategy,
        library: library,
        materialFolder: materialFolder
    });
  }

  /** 按行拆分并去掉空行 */
  function splitLines(text) {
    var out = [];
    var lines = String(text || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var v = lines[i].replace(/^\s+|\s+$/g, '');
      if (v) out.push(v);
    }
    return out;
  }

  /**
   * 列表拆分：优先按行；如果只有一行且里面有「/」分隔，
   * 再按「/」拆开（用户在表格里是 10000001/10000002/... 这种一行多值）。
   */
  function splitList(text) {
    var lines = splitLines(text);
    if (lines.length === 1 && /[\/／|｜]/.test(lines[0])) {
      var parts = lines[0].split(/[\/／|｜]+/);
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        var v = parts[i].replace(/^\s+|\s+$/g, '');
        if (v) out.push(v);
      }
      if (out.length > 1) return out;
    }
    return lines;
  }

  /* -------------------- 分批队列（跨页面刷新） -------------------- */

  function saveQueue(idx) {
    try {
      // 注意：chrome.storage.session 在内容脚本里不可访问，必须用 local
      chrome.storage.local.set({
        mb5Queue: { list: STATE.queue, idx: idx, opts: STATE.opts, ts: Date.now() }
      });
    } catch (e) {}
  }

  function clearQueue() {
    STATE.queue = null; STATE.queueIndex = 0;
    try { chrome.storage.local.remove(['mb5Queue']); } catch (e) {}
  }

  function runNextInQueue() {
    var q = STATE.queue;
    if (!q || STATE.queueIndex >= q.length) { clearQueue(); return; }
    var item = q[STATE.queueIndex];
    STATE.running = false; STATE.paused = false; STATE.stopped = false; STATE.failedStep = -1;
    log('—'.repeat(0) + '🔄 [' + (STATE.queueIndex + 1) + '/' + q.length + '] 账户 ' + item.account + '，短剧「' + item.drama + '」');
    run({
      accounts: [item.account],
      drama: item.drama,
      landing: item.landing || item.drama,
      copyTemplate: STATE.opts.copyTemplate,
      strategy: STATE.opts.strategy,
      library: STATE.opts.library,
      materialFolder: STATE.opts.materialFolder,
      queueInfo: { index: STATE.queueIndex, total: q.length }
    });
  }

  /** 刷新后自动接着跑下一个账户 */
  function tryResumeQueue() {
    try {
      // 单广告多账户模式不再分广告续跑：清掉旧队列，直接结束
      try { chrome.storage.local.remove(['mb5Queue']); } catch (e0) {}
      if (true) return;
      chrome.storage.local.get(['mb5Queue'], function (v) {
        var q = v && v.mb5Queue;
        if (!q || !q.list || !q.list.length) return;
        if (q.idx >= q.list.length) { clearQueue(); return; }
        // 超过 40 分钟的残留任务不再自动续跑，避免隔天误触发
        if (q.ts && (Date.now() - q.ts) > 40 * 60 * 1000) { clearQueue(); return; }

        STATE.queue = q.list;
        STATE.queueIndex = q.idx;
        STATE.opts = q.opts || { copyTemplate: true, strategy: null };
        STATE.strategy = STATE.opts.strategy || null;

        // 面板上同步显示「已启用售卖策略 + 文件名」，避免看起来像没启用
        try {
          if (STATE.opts.strategy) {
            var ckEl = document.getElementById('mb5-strategy');
            if (ckEl) ckEl.checked = true;
            var fnEl = document.getElementById('mb5-fname');
            if (fnEl) fnEl.textContent = STATE.opts.strategy.name || '已加载';
          }
        } catch (e) {}

        log('⏳ 检测到未完成的分批任务（第 ' + (q.idx + 1) + '/' + q.list.length + ' 个），等待页面就绪后自动继续');
        var waited = 0;
        var timer = setInterval(function () {
          waited += 500;
          var ready = false;
          var btns = document.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            if (!visible(btns[i])) continue;
            if ((btns[i].textContent || '').replace(/\s+/g, '').trim() === '更改') { ready = true; break; }
          }
          if (ready || waited > 60000) {
            clearInterval(timer);
            if (!STATE.running) runNextInQueue();
          }
        }, 500);
      });
    } catch (e) {}
  }

  function updateStatus() {
    var start = document.getElementById('mb5-start');
    var pause = document.getElementById('mb5-pause');
    var stop = document.getElementById('mb5-stop');
    var ball = document.getElementById('mb5-ball');
    if (!start) return;

    if (STATE.running) {
      start.disabled = true; stop.disabled = false; pause.disabled = false;
      pause.textContent = STATE.paused ? '▶ 继续' : '⏸ 暂停';
      if (ball) ball.classList.add('mb5-running');
    } else {
      start.disabled = false; pause.disabled = true; stop.disabled = true;
      pause.textContent = '⏸ 暂停';
      if (ball) ball.classList.remove('mb5-running');
    }
  }

  function setStep(txt) {
    var el = document.getElementById('mb5-step');
    if (el) el.textContent = txt;
  }

  /* -------------------- popup 消息入口 -------------------- */

  function setupMessageListeners() {
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg) return false;
        if (msg.action === 'start') {
          injectPanel();
          if (STATE.running) { sendResponse({ ok: false, error: '正在执行中，请先点面板上的停止' }); return true; }
          if (!msg.payload || !msg.payload.library || !msg.payload.materialFolder) {
            sendResponse({ ok: false, error: '启动参数缺少商品库或素材目录' });
            return true;
          }
          if (msg.payload && msg.payload.accounts) document.getElementById('mb5-accounts').value = msg.payload.accounts.join(', ');
          if (msg.payload && msg.payload.drama) document.getElementById('mb5-drama').value = msg.payload.drama;
          if (msg.payload && msg.payload.library) document.getElementById('mb5-library').value = msg.payload.library;
          if (msg.payload && msg.payload.materialFolder) document.getElementById('mb5-material-folder').value = msg.payload.materialFolder;
          run(msg.payload || {});
          sendResponse({ ok: true, build: BUILD });
          return true;
        }
        if (msg.action === 'ping') {
          sendResponse({ ok: true, build: BUILD, running: STATE.running });
          return true;
        }
        return false;
      });
    } catch (e) {}
  }

  /* -------------------- 启动 -------------------- */

  function boot() {
    if (!document.body) { setTimeout(boot, 500); return; }
    injectPanel();
    setupMessageListeners();
    try { console.log('[MB5] content.js ' + BUILD + ' 已注入'); } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // SPA 路由切换兜底
  setTimeout(function () { if (!document.getElementById('mb5-panel')) injectPanel(); }, 2000);

  // 仅供本地自测使用（正常页面不会设置 __MB_TEST__）
  if (window.__MB_TEST__) {
    window.__MB_DEBUG__ = {
      parseStrategyXlsx: parseStrategyXlsx,
      parseStrategyFile: parseStrategyFile,
      buildSpecIndex: buildSpecIndex,
      specFor: specFor,
      stripStrategyColumn: stripStrategyColumn,
      specOf: specOf,
      specMatchCells: specMatchCells,
      nameHit: nameHit,
      normNum: normNum,
      splitLines: splitLines,
      splitList: splitList,
      ctxDramas: ctxDramas,
      ctxUnified: ctxUnified,
      landingSplitNeeded: landingSplitNeeded,
      findAccountNode: findAccountNode,
      countAccountNodes: countAccountNodes,
      findRuleCard: findRuleCard,
      isChoiceActive: isChoiceActive,
      materialPickFolder: materialPickFolder,
      materialEnsureFolder: materialEnsureFolder,
      materialSearch: materialSearch,
      searchMaterialWithManualWait: searchMaterialWithManualWait,
      findMaterialSearchInput: findMaterialSearchInput,
      findFolderRow: findFolderRow,
      findFilterLabel: findFilterLabel,
      findRowControls: findRowControls,
      landingRowScore: landingRowScore,
      activateChoice: activateChoice,
      clickAccountRow: clickAccountRow,
      sleep: sleep,
      cancelAllSleeps: cancelAllSleeps,
      setStopped: function (v) { STATE.stopped = !!v; },
      setPaused: function (v) { STATE.paused = !!v; },
      stepLabels: function () {
        var out = [];
        for (var i = 0; i < STEPS.length; i++) out.push(STEPS[i].label);
        return out;
      },
      runStep: function (label, ctx) {
        for (var i = 0; i < STEPS.length; i++) {
          if (STEPS[i].label === label) return STEPS[i].fn(ctx);
        }
        return Promise.reject(new Error('没有这个步骤：' + label));
      },
      closeFailDetailDlg: closeFailDetailDlg,
      getDialogByTitle: getDialogByTitle,
      saveQueue: function (list, idx, opts) {
        STATE.queue = list; STATE.queueIndex = idx; STATE.opts = opts || {};
        saveQueue(idx);
      },
      readQueue: function () {
        return new Promise(function (res) {
          try { chrome.storage.local.get(['mb5Queue'], function (v) { res(v && v.mb5Queue); }); }
          catch (e) { res({ error: e.message }); }
        });
      },
      clearQueue: clearQueue
    };
  }

})();

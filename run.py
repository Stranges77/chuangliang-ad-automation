"""
创量广告批量投放自动化脚本
============================
跑之前请先看 README.md，按顺序：
  1. 安装 Python 3.12+ 和依赖
  2. 安装 Chromium：python -m playwright install chromium
  3. 第一次运行会弹出窗口让你手动登录创量，之后自动记住 cookie
  4. 再次运行，脚本会弹输入框让你填账户 ID 和短剧名，然后自动走完流程
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

# ---------- 依赖检查 ----------
_MISSING = []
try:
    import tkinter as tk
    from tkinter import ttk, messagebox
except ImportError as e:
    _MISSING.append(f"tkinter({e})")

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError as e:
    _MISSING.append(f"playwright({e})")

if _MISSING:
    print("缺少依赖:", ", ".join(_MISSING))
    print("请先执行：pip install playwright && python -m playwright install chromium")
    sys.exit(1)


# ---------- 基础配置 ----------
SCRIPT_DIR = Path(__file__).parent.resolve()
CONFIG_PATH = SCRIPT_DIR / "config.json"
DEFAULT_CONFIG = {
    "chuangliang_base_url": "https://promotion.mobgi.com/",
    "timeout_ms": 15000,
    "page_timeout_ms": 30000,
    "profile_dir": "./profile",
    "shuffle_times": 3,
}


def load_config() -> dict:
    """读取可选的 config.json；文件不存在时使用安全默认值。"""
    config = dict(DEFAULT_CONFIG)
    if not CONFIG_PATH.exists():
        return config
    try:
        values = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"config.json 读取失败: {exc}")
        sys.exit(1)
    if not isinstance(values, dict):
        print("config.json 顶层必须是 JSON 对象")
        sys.exit(1)
    config.update({k: v for k, v in values.items() if k in DEFAULT_CONFIG})
    return config


CONFIG = load_config()
PROFILE_DIR = (SCRIPT_DIR / str(CONFIG["profile_dir"])).resolve()
LOG_DIR = SCRIPT_DIR / "logs"


# ---------- 日志 ----------
LOG_DIR.mkdir(exist_ok=True)
log_file = LOG_DIR / f"run_{datetime.now():%Y%m%d_%H%M%S}.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("ad_draft")


# ---------- 输入弹窗 ----------
def prompt_inputs() -> dict:
    """弹出 tkinter 窗口让用户填账户 ID 和短剧名"""
    root = tk.Tk()
    root.title("创量批量投放 - 参数输入")
    root.geometry("520x340")
    root.attributes("-topmost", True)

    # 居中
    root.update_idletasks()
    w, h = 520, 340
    x = (root.winfo_screenwidth() - w) // 2
    y = (root.winfo_screenheight() - h) // 2
    root.geometry(f"{w}x{h}+{x}+{y}")

    result = {"accounts": "", "drama": "", "copy_template": True, "ok": False}

    pad = {"padx": 16, "pady": 6}
    ttk.Label(root, text="账户 ID（支持多账户，用逗号、空格或换行分隔）").pack(**pad, anchor="w")
    accounts_text = tk.Text(root, height=5)
    accounts_text.pack(fill="x", **pad)

    ttk.Label(root, text="短剧名（用于搜索素材 / 产品 / 落地页）").pack(**pad, anchor="w")
    drama_entry = ttk.Entry(root)
    drama_entry.pack(fill="x", **pad)

    cb = tk.BooleanVar(value=True)
    ttk.Checkbutton(root, text="勾选后会自动点击「复用」沿用上次模板（定向/出价/预算等固定项）",
                    variable=cb).pack(**pad, anchor="w")

    def confirm():
        result["accounts"] = accounts_text.get("1.0", "end").strip()
        result["drama"] = drama_entry.get().strip()
        result["copy_template"] = cb.get()
        if not result["accounts"] or not result["drama"]:
            messagebox.showerror("请填写完整", "账户 ID 和短剧名都不能为空")
            return
        result["ok"] = True
        root.destroy()

    btn_frame = ttk.Frame(root)
    btn_frame.pack(fill="x", **pad)
    ttk.Button(btn_frame, text="确定", command=confirm).pack(side="right", padx=4)
    ttk.Button(btn_frame, text="取消", command=lambda: (result.update(ok=False), root.destroy())).pack(side="right")

    root.mainloop()

    if not result["ok"]:
        log.info("用户取消")
        sys.exit(0)

    # 解析账户 ID
    ids = [x for x in result["accounts"].replace("\n", ",").replace(" ", ",").split(",") if x.strip()]
    ids = list(dict.fromkeys(ids))  # 去重保序
    if not all(i.isdigit() for i in ids):
        if not messagebox.askyesno("账户 ID 格式可疑",
                                   f"检测到账户 ID 里有非纯数字：{ids[:5]}，继续吗？"):
            sys.exit(1)
    return {"accounts": ids, "drama": result["drama"], "copy_template": result["copy_template"]}


# ---------- 辅助函数 ----------
def _by_role(page, role: str, name=None, exact=False):
    """优先用 get_by_role 定位，找不到回退到 locator(has_text)"""
    loc = page.get_by_role(role, name=name, exact=exact) if name else page.get_by_role(role)
    return loc


def click(page, selector, desc: str, timeout=None, retry=2):
    """带重试的点击，selector 可以是 CSS/XPath/role 定位器"""
    timeout = int(CONFIG["timeout_ms"]) if timeout is None else timeout
    last_err = None
    for attempt in range(retry + 1):
        try:
            if isinstance(selector, str):
                el = page.locator(selector).first
            else:
                el = selector.first if hasattr(selector, "first") else selector
            el.wait_for(state="visible", timeout=timeout)
            el.click(timeout=timeout)
            log.info(f"✓ 点击: {desc}")
            return True
        except Exception as e:
            last_err = e
            log.warning(f"  重试 {attempt+1}/{retry} 点击 {desc}: {e}")
            time.sleep(1)
    raise RuntimeError(f"点击失败 {desc}: {last_err}")


def fill(page, selector, text: str, desc: str, clear=True, timeout=None):
    timeout = int(CONFIG["timeout_ms"]) if timeout is None else timeout
    el = page.locator(selector).first if isinstance(selector, str) else selector.first
    el.wait_for(state="visible", timeout=timeout)
    if clear:
        el.fill("")
        time.sleep(0.2)
    el.fill(text, timeout=timeout)
    log.info(f"✓ 填写: {desc} = {text}")
    return el


def wait_for_url_contains(page, needle: str, timeout=None):
    timeout = int(CONFIG["page_timeout_ms"]) if timeout is None else timeout
    log.info(f"  等待 URL 包含: {needle}")
    page.wait_for_url(f"**/*{needle}*", timeout=timeout)


def safe_screenshot(page, label: str):
    path = LOG_DIR / f"step_{label}_{datetime.now():%H%M%S}.png"
    try:
        page.screenshot(path=str(path), full_page=False)
        log.info(f"  截图 → {path}")
    except Exception as e:
        log.warning(f"  截图失败: {e}")


# ---------- 核心流程 ----------
class AdDraftRunner:
    def __init__(self, playwright, inputs: dict):
        self.pw = playwright
        self.inputs = inputs
        self.accounts = inputs["accounts"]
        self.drama = inputs["drama"]
        self.browser = None
        self.context = None
        self.page = None
        self.step = 0

    # ========== 启动 ==========
    def launch(self):
        PROFILE_DIR.mkdir(exist_ok=True)
        log.info(f"启动 Chromium，持久化目录: {PROFILE_DIR}")

        self.context = self.pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport={"width": 1440, "height": 900},
            args=["--start-maximized"],
        )
        self.context.grant_permissions(["notifications"])
        self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
        self.page.set_default_timeout(int(CONFIG["page_timeout_ms"]))
        self.page.set_default_navigation_timeout(int(CONFIG["page_timeout_ms"]))

    def goto(self):
        self.page.goto(CONFIG["chuangliang_base_url"], wait_until="domcontentloaded")
        self.page.wait_for_timeout(1500)
        self.handle_login_if_needed()

    def handle_login_if_needed(self):
        """如果还没登录，让用户手动登录后再继续"""
        # 简单判定：如果 URL 还在 login.* 或页面有"登录"按钮，就弹窗等用户
        url = self.page.url
        if "login" in url.lower() or "sign" in url.lower():
            log.warning("检测到需要登录，请在浏览器里手动登录后回到终端按回车继续…")
            input("登录完成后，回到这个窗口按 Enter 继续")
            self.page.reload(wait_until="domcontentloaded")
            self.page.wait_for_timeout(2000)

    # ========== 23 步核心 ==========

    def _step(self, label: str):
        self.step += 1
        log.info(f"── Step {self.step}: {label} ──")

    # ---- 第一组：改账户（step 1-5）----

    def step_01_goto(self):
        self._step("初始界面 - 点左上角账户的更改按钮")
        self.page.goto(CONFIG["chuangliang_base_url"], wait_until="networkidle")
        # 先找创量里"更改"按钮（不同版本位置可能变，用 role + 文字兜底）
        btn = self.page.get_by_role("button", name=re.compile("更改"))
        if btn.count() == 0:
            # 更宽松：找任何可见的"更改"文本旁边有"账户"字样的区域
            btn = self.page.locator("text=/更改/").first
        click(self.page, btn, "更改账户")

    def step_02_clear_existing(self):
        self._step('点“清空已选”按钮 + “清空”按钮')
        # 这两个按钮在"选择媒体账户"弹窗里
        clear_all = self.page.get_by_role("button", name="清空已选")
        if clear_all.count() > 0:
            click(self.page, clear_all, "清空已选")
        # 有时候第二个"清空"按钮在别处（比如搜索框右侧）
        clear_btn = self.page.locator("button:has-text('清空'), [role=button]:has-text('清空')").first
        if clear_btn.count() > 0 and clear_btn.is_visible():
            click(self.page, clear_btn, "清空")

    def step_03_batch_add_accounts(self):
        self._step("点箭头所指按钮（批量添加/导入账户）")
        # image3 里红箭头指向的按钮，看样子像一个带加号或"批量添加"的按钮
        # 创量常见的按钮文字："批量添加" / "导入账户" / 一个 + 号图标
        add_btn = (
            self.page.get_by_role("button", name=re.compile("批量|导入|添加"))
            .first
        )
        if add_btn.count() == 0:
            add_btn = self.page.locator("button:has-text('添加'), button:has-text('导入')").first
        click(self.page, add_btn, "批量添加账户")

    def step_04_paste_account_ids(self):
        self._step("在文本框里粘贴账户 ID，点确定")
        account_text = "\n".join(self.accounts)
        # image4 显示有一个“请输入 ID”的多行文本框。逐个候选尝试填写，
        # 避免依赖某个容易变化的 placeholder 或 DOM 层级。
        filled = False
        for candidate in self.page.locator("textarea, input[type='text']").all():
            try:
                candidate.fill("")
                candidate.fill(account_text)
                filled = True
                break
            except Exception:
                continue
        if not filled:
            raise RuntimeError("没找到账户ID输入框")

        ok = self.page.get_by_role("button", name="确定").last
        click(self.page, ok, "批量添加账户 - 确定")
        self.page.wait_for_timeout(1000)

    def step_05_select_all_and_confirm(self):
        self._step("全选账户 + 确定")
        # "全选"一般在列表上方或底部，是 checkbox 或按钮
        select_all = self.page.locator("text=全选").first
        click(self.page, select_all, "全选")
        # 点弹窗的"确定"（image5 右下角有个蓝色确定按钮）
        ok = self.page.locator("button:text-is('确定'), button:has-text('确定')").last
        click(self.page, ok, "账户选择 - 确定")
        self.page.wait_for_timeout(1500)

    # ---- 第二组：复用模板（step 6）----

    def step_06_reuse_template(self):
        self._step('点“复用”按钮')
        if not self.inputs["copy_template"]:
            log.info("用户没勾「复用模板」，跳过")
            return
        reuse = self.page.locator("button:has-text('复用'), [role=button]:has-text('复用')").first
        click(self.page, reuse, "复用模板")
        self.page.wait_for_timeout(800)
        # image6 显示有个"确认/取消"弹窗，再点确认
        confirm = self.page.locator("button:has-text('确认'), button:has-text('是')").first
        if confirm.count() > 0 and confirm.is_visible():
            click(self.page, confirm, "复用确认弹窗 - 确认")
        self.page.wait_for_timeout(1500)

    # ---- 第三组：换短剧产品（step 7-13）----

    def step_07_goto_ad_creative_edit(self):
        self._step("广告创意 → 编辑")
        edit = self.page.locator("button:has-text('编辑'), [role=button]:has-text('编辑')").first
        click(self.page, edit, "广告创意编辑")
        self.page.wait_for_timeout(1200)

    def step_08_change_selected_product(self):
        self._step('点“修改已选产品”')
        change = self.page.locator("text=/修改已选产品/").first
        click(self.page, change, "修改已选产品")
        self.page.wait_for_timeout(1000)

    def step_09_clear_old_drama(self):
        self._step("清除已选择的短剧")
        # image9 右侧红箭头指向一个 × 号
        close_btns = self.page.locator("button[aria-label='Close'], [role=button][aria-label='Close']").all()
        if not close_btns:
            close_btns = self.page.locator("span.close, .icon-close, button.close").all()
        for b in close_btns:
            try:
                if b.is_visible():
                    b.click()
                    time.sleep(0.2)
            except Exception:
                pass
        # 兜底：如果还有旧剧，直接点 × 图标
        while True:
            old = self.page.locator("[class*='remove'], [class*='delete'], button[class*='close']").first
            try:
                if old.is_visible():
                    old.click()
                    time.sleep(0.2)
                else:
                    break
            except Exception:
                break
        self.page.wait_for_timeout(600)

    def step_10_search_drama(self):
        self._step("搜索新剧名")
        # 清空再输入
        search = self.page.locator("input[placeholder*='搜索'], input[placeholder*='商品']").first
        if search.count() == 0:
            search = self.page.get_by_role("textbox").last
        # 等可输入
        search.wait_for(state="editable", timeout=8000)
        search.fill("")
        time.sleep(0.3)
        search.fill(self.drama)
        time.sleep(1.5)  # 等搜索结果

    def step_11_select_first_result(self):
        self._step("选中搜索结果里的短剧")
        # image11/12 显示在搜索结果里选一条带 checkbox 的
        # 注意：用户说"可能出现重复，需要手动处理"——这里只选第一条精确匹配
        rows = self.page.locator("[class*='product'] [class*='row'], .ant-table-row, [class*='list'] [class*='row']").all()
        picked = False
        for r in rows:
            try:
                if r.is_visible() and self.drama in r.inner_text():
                    # 点这行的 checkbox
                    cb = r.locator("input[type='checkbox'], [class*='checkbox'], [role='checkbox']").first
                    cb.click()
                    picked = True
                    break
            except Exception:
                continue
        if not picked:
            # 兜底：点第一行
            first = self.page.locator(".ant-table-row, [class*='row']").first
            first.locator("input[type='checkbox']").first.click()
        self.page.wait_for_timeout(600)

    def step_12_confirm_product(self):
        self._step("确定 → 保存")
        ok = self.page.locator("button:has-text('确定')").last
        click(self.page, ok, "短剧选择 - 确定")
        self.page.wait_for_timeout(1200)
        save = self.page.locator("button:has-text('保存')").last
        click(self.page, save, "广告创意 - 保存")
        self.page.wait_for_timeout(1500)

    # ---- 第四组：换素材（step 14-19）----

    def step_13_goto_select_materials(self):
        self._step("创意素材 → 选择素材")
        # image14 红箭头指向 "选择素材" 按钮在创意素材卡片上
        sel = self.page.locator("a:has-text('选择素材'), button:has-text('选择素材'), [role=button]:has-text('选择素材')").first
        click(self.page, sel, "选择素材")
        self.page.wait_for_timeout(1500)

    def step_14_clear_current(self):
        self._step("清空当前素材")
        # image15 底部有个"清空"按钮
        clear = self.page.locator("button:has-text('清空'), [role=button]:has-text('清空')").last
        click(self.page, clear, "素材 - 清空")
        self.page.wait_for_timeout(600)

    def step_15_add_video(self):
        self._step("点添加视频按钮")
        # image16 显示"批量添加"旁边有个"添加视频"
        add_v = self.page.locator("button:has-text('添加视频'), [role=button]:has-text('添加视频')").first
        click(self.page, add_v, "添加视频")
        self.page.wait_for_timeout(1200)

    def step_16_search_materials(self):
        self._step("清空搜索框 + 输入剧名搜索")
        # image17 有个搜索框，右侧有个清空按钮（×）
        # 先清空
        clear_x = self.page.locator("button[aria-label='Close'], [role=button][aria-label='Close']").first
        if clear_x.count() > 0 and clear_x.is_visible():
            clear_x.click()
        # 再输入剧名
        box = self.page.locator("input[placeholder*='搜索']").first
        box.fill("")
        time.sleep(0.3)
        box.fill(self.drama)
        time.sleep(2)  # 等搜索出来

    def step_17_select_two_pages(self):
        self._step("前 2 页素材全选")
        # image18 底部有"全选"和分页 1 / 2
        all_btn = self.page.locator("text=全选").first
        click(self.page, all_btn, "第 1 页全选")

        # 翻到第 2 页
        page2 = self.page.locator("text=2").first
        click(self.page, page2, "翻到第 2 页")
        self.page.wait_for_timeout(1200)
        # 再次全选——注意"快速选择"可能只勾当前页，需要分别点
        # image18 底部红箭头是"快速选择"旁边的"全选"，可能已经变成"反选"
        # 保守做法：第 2 页直接勾上（如果第一页的选择被保留）
        all2 = self.page.locator("text=全选").first
        if all2.count() > 0 and all2.is_visible():
            click(self.page, all2, "第 2 页全选")
        self.page.wait_for_timeout(800)

        # 点弹窗的"确定"（素材选择完了）
        ok = self.page.locator("button:has-text('确定')").last
        click(self.page, ok, "素材库 - 确定")
        self.page.wait_for_timeout(1200)

    def step_18_shuffle_three_times(self):
        shuffle_times = int(CONFIG["shuffle_times"])
        self._step(f"乱序 {shuffle_times} 次（重要！）")
        # image19 红箭头指向一个叫"乱序"的按钮
        # 有时候按钮图标不是文字而是一个随机图标，兜底按 class 里的 shuffle 找
        for i in range(shuffle_times):
            shuf = (
                self.page.locator("button:has-text('乱序'), [role=button]:has-text('乱序')")
                .or_(self.page.locator("[class*='shuffle'], [class*='random'], [class*='order']"))
                .first
            )
            if shuf.count() == 0:
                log.warning("没找到乱序按钮，用 '乱序' 文本兜底")
                shuf = self.page.locator("text=乱序").first
            click(self.page, shuf, f"乱序 第 {i+1} 次")
            time.sleep(0.5)

    def step_19_confirm_materials(self):
        self._step("素材配置 - 点确定保存")
        ok = self.page.locator("button:has-text('确定'), button:has-text('保存')").last
        click(self.page, ok, "素材配置 - 确定")
        self.page.wait_for_timeout(1500)

    # ---- 第五组：落地页（step 20-22）----

    def step_20_add_landing(self):
        self._step("落地页 → 添加按钮")
        # image20 红箭头指向"落地页"那一行的"添加"按钮
        add = self.page.locator("button:has-text('添加'), [role=button]:has-text('添加')").last
        click(self.page, add, "落地页 - 添加")
        self.page.wait_for_timeout(1200)

    def step_21_search_and_pick(self):
        self._step("按剧名搜小程序，选 1 个")
        # image21 有"搜索"按钮和弹窗
        # 先点搜索，再输入剧名
        search_btn = self.page.locator("button:has-text('搜索')").first
        if search_btn.count() > 0:
            click(self.page, search_btn, "落地页 - 点搜索")
        box = self.page.locator("input[placeholder*='搜索']").first
        box.fill("")
        time.sleep(0.3)
        box.fill(self.drama)
        time.sleep(2)

        # 选第一条（image22 里有 checkbox）
        first_row = self.page.locator(".ant-table-row, [class*='row']").first
        cb = first_row.locator("input[type='checkbox'], [role='checkbox']").first
        cb.click()
        self.page.wait_for_timeout(500)

    def step_22_confirm_landing(self):
        self._step("落地页弹窗 - 确定")
        ok = self.page.locator("button:has-text('确定')").last
        click(self.page, ok, "落地页 - 确定")
        self.page.wait_for_timeout(1500)

    # ---- 第六组：生成预览广告（step 23）----

    def step_23_generate_preview(self):
        self._step('点底部“生成预览广告”')
        gen = self.page.locator("button:has-text('生成预览广告'), [role=button]:has-text('生成预览广告')").first
        click(self.page, gen, "生成预览广告")
        self.page.wait_for_timeout(2000)
        log.info("🎉 预览广告生成完成！请在页面上检查后手动提交")
        safe_screenshot(self.page, "preview_ready")

    # ========== 收尾 ==========
    def close(self):
        if self.context:
            self.context.close()

    # ========== 一键运行 ==========
    def run(self):
        self.launch()
        self.goto()

        try:
            self.step_01_goto()
            self.step_02_clear_existing()
            self.step_03_batch_add_accounts()
            self.step_04_paste_account_ids()
            self.step_05_select_all_and_confirm()
            self.step_06_reuse_template()
            self.step_07_goto_ad_creative_edit()
            self.step_08_change_selected_product()
            self.step_09_clear_old_drama()
            self.step_10_search_drama()
            self.step_11_select_first_result()
            self.step_12_confirm_product()
            self.step_13_goto_select_materials()
            self.step_14_clear_current()
            self.step_15_add_video()
            self.step_16_search_materials()
            self.step_17_select_two_pages()
            self.step_18_shuffle_three_times()
            self.step_19_confirm_materials()
            self.step_20_add_landing()
            self.step_21_search_and_pick()
            self.step_22_confirm_landing()
            self.step_23_generate_preview()
        except Exception as e:
            log.exception("❌ 流程中断")
            safe_screenshot(self.page, "error")
            input("发生错误，请查看上方日志和 logs/error.png。按回车关闭浏览器…")
        finally:
            self.close()


# ---------- 入口 ----------
def main():
    inputs = prompt_inputs()
    log.info(f"开始投放: 账户={inputs['accounts']}, 剧名={inputs['drama']}, 复用模板={inputs['copy_template']}")
    with sync_playwright() as pw:
        runner = AdDraftRunner(pw, inputs)
        runner.run()


if __name__ == "__main__":
    main()

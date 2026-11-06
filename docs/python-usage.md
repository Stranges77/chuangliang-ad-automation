# Python Playwright 版使用说明

Python 版对应 23 步手工操作基线，是扩展之外的独立运行方式。

## 适用范围

- 多账户共用同一部短剧。
- 使用 Playwright 持久化浏览器登录态。
- 需要独立 Chromium 窗口的操作场景。

当前不支持：

- 多账户各自一剧。
- 售卖策略 XLSX。
- 扩展中的按账户素材和落地页分配。

## 安装

```powershell
pip install -r requirements.txt
python -m playwright install chromium
```

## 首次登录

```powershell
python run.py
```

首次运行需要填写账户和短剧，并在打开的 Chromium 中手动登录平台。

登录态保存在 `profile/`。该目录包含浏览器会话数据，不得提交或分享。

## 日常运行

1. 执行 `python run.py`。
2. 填写账户 ID 和短剧名。
3. 选择是否复用模板。
4. 等待流程停在“生成预览广告”。
5. 人工检查后决定是否提交审核。

## 可选配置

将 `config.example.json` 复制为 `config.json` 后可调整：

- 平台入口 URL。
- 点击和页面等待时间。
- Playwright 持久化目录。
- 素材乱序次数。

`config.json` 已加入 `.gitignore`，不要提交包含本地路径的真实配置。

## 日志

运行日志和错误截图位于 `logs/`。这些文件可能包含页面信息，不得提交到公开位置。

## 已知限制

- 页面定位依赖平台文案和 DOM，平台改版后可能失效。
- 没有自动化测试覆盖真实平台。
- 部分微信/广告平台账号或风控规则可能阻止自动化运行。

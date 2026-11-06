# 安全说明

## 报告问题

如果在代码、示例、日志或文档中发现以下问题，请通过私有渠道联系维护者，不要先创建公开 Issue：

- 真实账户、Cookie、Token 或密码。
- 客户、投手、短剧或售卖策略数据。
- 权限绕过或意外数据上传。
- 可能影响账号或业务数据的安全缺陷。

## 本地数据

- `profile/` 保存 Python 版浏览器登录态。
- `logs/` 保存 Python 版运行日志和错误截图。
- 浏览器扩展只在本机处理当前输入和策略文件。
- 扩展不会持久化账户、短剧、商品库和素材目录。

不得把上述本地数据提交到 Git、Issue、网盘或聊天记录中。

## 权限

扩展只声明：

- `activeTab`
- `scripting`
- `storage`
- `tabs`
- `https://*.mobgi.com/*`

修改权限前应重新审查 manifest 和文档。

## 发布检查

```powershell
python scripts/check_release.py
node --check extension/content.js
node --check extension/popup.js
```

还应人工检查 Git diff、示例值、截图和提交历史。


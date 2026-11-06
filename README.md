# 创量批量投放助手

> Version: **v1.0.0**
>
> Status: Private release candidate
>
> License: 尚未授予公开许可证，未经授权不得复制或再分发

一个用于减少短剧广告草稿重复操作的本地自动化工具。项目提供浏览器扩展和 Python Playwright 两种运行方式，最终操作停在“生成预览广告”，不会自动提交审核。

## 重要声明

本项目是独立工具，与创量平台及其运营方不存在隶属、授权、代理或背书关系。

请仅在自己拥有合法权限的账户和数据上使用。自动化操作可能受到平台服务条款、账号权限、内容版权、公司制度和适用法律的限制，并可能因平台改版而失效。使用者需要自行检查每一步结果并承担使用风险。

本项目不提供绕过登录、验证码、访问控制或平台风控的功能。使用前请阅读 [DISCLAIMER.md](DISCLAIMER.md) 和 [隐私与合规说明](docs/privacy-and-compliance.md)。

## 当前能力

| 能力 | Python Playwright | 浏览器扩展 |
|---|---:|---:|
| 多账户共用一部短剧 | 支持 | 支持“统一模式” |
| 多账户各自一部短剧 | 不支持 | 支持 |
| 修改推广产品 | 支持 | 支持，可按账户处理 |
| 素材前两页全选、乱序三次 | 支持 | 支持 |
| 按账户选择素材和落地页 | 不支持 | 支持 |
| 售卖策略 XLSX | 不支持 | 支持 |
| 同名短剧人工接管 | 基础 | 支持 |
| 最后自动提交审核 | 不执行 | 不执行 |

浏览器扩展是当前推荐入口。Python 脚本保留为传统的 23 步 Playwright 实现。

## 快速开始：浏览器扩展

1. 打开 Edge 或 Chrome 的扩展管理页面。
2. 开启开发人员模式。
3. 选择“加载解压缩的扩展”，指向本项目的 `extension/` 目录。
4. 登录创量并打开广告投放页面。
5. 点击扩展图标，填写：
   - 账户 ID
   - 短剧名
   - 商品库名称
   - 素材目录名称
6. 点击“开始执行”。
7. 在页面右下角查看执行步骤和日志。
8. 完成后人工检查预览，再决定是否提交审核。

商品库和素材目录必须与平台显示的名称一致。扩展不会保存账户 ID、短剧名、商品库或素材目录。

完整说明见 [浏览器扩展使用说明](docs/extension-usage.md)。

## 两种账户模式

### 统一模式

多个账户共用一部短剧，适合统一素材和落地页的批量草稿。

- [统一模式说明](docs/mode-unified.md)

### 多账户（各自一剧）

账户列表和短剧列表逐行对应，推广产品、素材、售卖策略和落地页按账户设置。

- [多账户模式说明](docs/mode-per-account.md)

## 售卖策略

售卖策略为付费短剧可选流程，支持在浏览器本地解析 XLSX。

- 匹配规则、列要求与异常处理见 [售卖策略说明](docs/strategy-xlsx.md)
- 不要提交真实策略文件、账户清单或客户数据

## Python Playwright 版

Python 版对应传统的 23 步手工流程，适合需要独立浏览器配置的场景。

```powershell
pip install -r requirements.txt
python -m playwright install chromium
python run.py
```

说明见 [Python 版使用说明](docs/python-usage.md)。Python 版目前不支持二代的售卖策略和按账户分剧流程。

## 人工操作基线

原始手工流程为 23 步，详见 [23 步业务基线](docs/manual-workflow-23-steps.md)。该文档用于解释业务步骤，不代表扩展内部仍有 23 个独立函数。

## 故障排查

常见问题和日志位置见 [故障排查](docs/troubleshooting.md)。

## 安全

- 扩展通过 `manifest.json` 限制在 `https://*.mobgi.com/*` 上运行。
- 售卖策略文件在浏览器内解析，再按正常页面流程交给目标平台。
- 不得提交 `profile/`、`logs/`、真实配置、Cookie、售卖策略或内部截图。
- 漏洞或隐私问题请按照 [SECURITY.md](SECURITY.md) 处理。

## 版本历史

版本规范见 [版本管理规则](docs/versioning.md)，历史记录见 [CHANGELOG.md](CHANGELOG.md)。

## 发布前检查

```powershell
python scripts/check_release.py
node --check extension/content.js
node --check extension/popup.js
```

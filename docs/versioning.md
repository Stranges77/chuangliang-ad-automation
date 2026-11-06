# 版本管理规则

## 语义化版本

版本格式：

```text
MAJOR.MINOR.PATCH
```

- `MAJOR`：不兼容的流程、配置或运行方式变化。
- `MINOR`：新增向后兼容的功能。
- `PATCH`：修复、兼容性更新和文档修正。

## 唯一版本来源

`extension/manifest.json` 的 `version` 是当前发布版本的规范来源。

以下位置必须同步：

- `extension/content.js` 的 `BUILD`
- `extension/popup.js` 的 `BUILD`
- `extension/popup.html` 中显示的版本
- `CHANGELOG.md`

运行：

```powershell
python scripts/check_release.py
```

## 历史编号

内部构建 `v8.2` 和 `v12.23` 分别整理为历史版本 `0.8.2` 和 `0.12.23`。当前规范化发布基线为 `1.0.0`。

缺失的中间构建不会伪造为新的 Git 提交或 tag。

## Git tag

私有发布候选验证通过后：

```powershell
git tag -a v1.0.0 -m "v1.0.0"
git push origin main
git push origin v1.0.0
```

其他镜像远端应指向相同的提交和 tag。


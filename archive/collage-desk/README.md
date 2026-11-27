# 截下来 · 拼贴工作桌

独立前端试玩版，包含便签墙和周/月日程。无需 npm 安装或运行后端。

## 打开

在此目录运行（需要 Python 3）：

```powershell
python -m http.server 5189 --bind 127.0.0.1
```

或者在 PowerShell 中运行 `./start.ps1`。

- 便签墙：http://127.0.0.1:5189/
- 周日程：http://127.0.0.1:5189/?view=inbox
- `desk.html` 保留为兼容入口。

使用本机 HTTP 预览可保证资源与本地存储行为一致。所有资源都在本文件夹中，可整体移动或复制。

## 可以试玩

- 新建任务、填写要求和截止日期。
- 便签正反面翻转、标记完成、恢复未完成。
- 调整安排日期和时间，贴到今天或从今天取下。
- 七列周日程、月视图、日期导航、展开全部任务。
- 当前浏览器本地保存，刷新保留；确认后重置示例。

安排日期与截止日期分别表达。当前每个任务仍是单一截止，多截止节点尚未接入。

## 文件

- `index.html` / `desk.html`：入口。
- `collage-planner.js` / `.css`：便签墙、日程、任务操作。
- `collage-local.js`：独立 localStorage 保存。
- `collage-effects.js` / `.css`：材质、翻面和静态背景。默认不启用持续 WebGL；`?fx=on` 可显式开启。
- `app.js`、`compositions.*`、`refinements.css`、`styles.css`、`collage-workspace.*`：页面所依赖的共享基础与纸面样式，保留加载顺序。
- `assets/`：四张实际使用的材质图片。
- `collage-backend.js`：保留的接口桥接，默认不发请求，无联调面板。
- `manifest.json`：运行文件清单与 SHA-256，便于核对拷贝完整性。

## 数据与接口边界

这是独立预览，不读写正式产品 IndexedDB。数据只在当前浏览器与当前地址保存；更换域名或端口会成为另一份存储。

接口入口保留为 `window.collageBackend.health()` 和 `window.collageBackend.importReference()`，只有显式调用时才请求后端。`window.JXL_API_BASE` / `?api=` 仍可指定后端地址，密钥不要写入前端。

此目录从 `frontend-drafts/` 复制整理，不包含其他方案、房间场景、历史归档、技能、后端服务或测试依赖。原草案和正式 `frontend/` 保留原位。

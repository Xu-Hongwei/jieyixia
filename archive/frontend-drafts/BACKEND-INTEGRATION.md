# 接口桥接保留说明（2026-11-19）

当前拼贴工作桌为独立前端体验，主页面已移除检查连接、导入示例、API 状态等联调界面。接口代码仍在 `collage-backend.js`，不会自动调用。需要联调时可显式调用 `window.collageBackend.health()` 或 `window.collageBackend.importReference()`；异常由调用方处理。`window.JXL_API_BASE` / `?api=` 仍可指定地址。当前桥接不是正式产品的数据接入方案。

当前任务保存在独立 localStorage 中，刷新保留；下文为接入历史记录，关于按钮入口与刷新重置的描述已经过时。后端/API/契约未因此修改。

---

# 拼贴工作桌 · 后端初版接入

当前前端桥接只接入后端的两个 P0 接口：

- `GET /api/healthz`：检查服务是否可达以及 fixture provider 是否就绪。
- `POST /api/analyze`：发送固定的 `src-04` 文本 fixture，把返回的标题、摘要、关键词映射成一条临时任务。

## 本地运行

在仓库根目录启动后端（fixture 模式，并允许草案前端跨域）：

```powershell
$env:JXL_PROVIDER='fixture'
$env:JXL_CORS_ORIGINS='http://127.0.0.1:5188,http://localhost:5188'
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

另开终端启动草案前端：

```powershell
python -m http.server 5188 --bind 127.0.0.1 --directory frontend-drafts
```

打开 `http://127.0.0.1:5188/desk.html?api=http://127.0.0.1:8000`，在“便签墙”或“日程表”页点击“检查连接”，再点击“导入后端示例”。

## 当前数据流

后端分析结果会通过 `collage-backend-task` 自定义事件交给 `collage-planner.js`，然后进入“日程表”的“全部任务”清单。由于 `src-04` 没有截止日期，任务会保留为空，并显示“截止时间仍待确认”；它不会被误贴到今日便签墙。

这是一个前端联调初版：任务只存在当前页面内，刷新后恢复演示数据；后端尚未提供任务持久化、收件箱写入或截止日期确认接口，因此本次没有改动后端源码，也没有把分析结果伪装成已确认任务。


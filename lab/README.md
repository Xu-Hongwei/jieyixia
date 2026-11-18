# lab · 接口联调台

**定位：验证后端接口与状态机的功能性页面，不是产品 UI。** 美观后置；产品前端由队友另建，同栈（Vue 3 + Vite + Tailwind v4 + shadcn-vue/Reka UI）。

## 跑起来

```bash
# 终端 1：后端（真模型或桩）
cd backend && python -m uvicorn app.main:app --reload --port 8000
# 终端 2：lab
cd lab && npm install && npm run dev   # http://localhost:5173
```

`/api` 由 Vite proxy 转发到 8000（CORS 已放行 5173）。

## 四个区与验证点

| 区 | 验证点 |
| --- | --- |
| 收集 | Ctrl+V / 拖入 / 选文件 / 纯文字；**原图先落 IndexedDB 再 analyze**；「仅保存」不调 AI |
| 便签核对 | 字段级 status/derived/origin 徽章；逐字原文引用；独立确认；编辑后 origin=user；便签 draft→reviewed / failed；原图侧栏不可被编辑覆盖 |
| 任务与今天 | 必须先确认 deadline 才能建任务；deadline 带 from_note_id；逾期优先排序；刷新后恢复 |
| 接口与降级 | healthz 徽章；注入 413/422/503 验证三条降级路径 |

## 结构

```
src/
  lib/db.js        IndexedDB：sources(blob+meta) / docs(notes+tasks)
  lib/api.js       healthz / analyze(fail 注入) / blob→base64
  lib/utils.js     cn = clsx + tailwind-merge
  components/ui/   shadcn-vue 风格组件（源码在仓库内，可继续 npx shadcn-vue add）
  App.vue          四区 + 状态机
```

组件按 shadcn-vue 约定手写最小集（Button/Card/Badge/Input/Textarea/Separator），交互原语用 Reka UI（Tabs）。主题令牌在 `src/main.css`（Tailwind v4 `@theme inline` + oklch zinc）。

## 已知边界

- 不做事项归组、专注、planner、演示模式（产品 UI 的职责）。
- 编辑数组字段时按行拆回数组；本地 note 不做契约再校验（契约校验在后端边界）。
- 数据仅存本浏览器；清站点数据即丢失（与 PRD F11 的隐私边界一致）。

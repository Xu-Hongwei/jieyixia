# 截下来 · 拼贴工作桌

当前主要维护拼贴方向。打开 `desk.html`，或在本目录运行 `python -m http.server 5188 --bind 127.0.0.1` 后访问 http://127.0.0.1:5188/desk.html 。无需启动后端。

房间时间窗景第一版：打开 `room.html`。它使用 `room-base-v4.webp` 作为房间底图，将小镇窗景、太阳/月亮/星星和室内色调拆成独立层；可跟随本地系统时间，也可手动切换清晨、正午、傍晚和夜间。

## 当前两页

- **今日便签墙**：`desk.html`。任务名与截止时间在正面，要求、产物与来源在背面。支持翻面、完成、从今日取下。
- **任务日程表**：`desk.html?view=inbox`。取代原收件箱；默认周视图，每天可安排多项任务，保留月视图。全部任务清单包含未安排任务，可从页头资料夹展开；电脑与平板按天独立滚动，手机按日期查看。

安排日期与截止日期独立；今天按北京时间读取，首次打开时示例日期整体平移到当前日期附近。安排在今天的任务出现在便签墙。调整安排、标记完成、添加任务会同步反映在两页中。

这是独立前端体验空间。任务、安排和完成状态保存到当前浏览器的独立 localStorage 键 `jxl-collage-playground-v1`，刷新保留；右上角“重置示例”经确认后恢复样例。不会读写正式产品 IndexedDB，不调用模型。存储不可用时页面会说明本次修改只能临时保留。尚未实现拖动排期、循环任务或时间冲突检查。

默认页面不显示后端状态、联调按钮或历史方案入口。`collage-backend.js` 仍暴露 `window.collageBackend.health()` / `importReference()` 作为未来接入桥梁；只有显式调用才发请求，打开页面不会请求 API。`collage-backend.css` 保留为历史接口面板样式，当前入口不加载。

本轮 DESK-05 在 DESK-04 的结构基础上继续细化整体工作桌：生成纸片和环境光素材进入实际页面，便签纸面可点击翻到背面，再点回正面；悬浮倾斜、CSS 3D 翻面与 WebGL 柔光共同工作，减少动态效果或 WebGL 不可用时退回静态画面。日期列仍在完成任务后保留阅读位置与键盘焦点。

当前已回到绿植窗外动效加入之前的基础拼贴工作桌；夏天窗景素材和验证记录保留在项目目录中作为历史候选，但不再由页面入口加载。

## 持续优化

- `DESKTOP-DESIGN.md`：稳定决定、当前问题、已解决问题、证据与下一步。
- `collage-planner.js` / `collage-planner.css`：本轮两页的专属实现。
- `output/playwright/desktop-03/verification.json`：当前实际检查结果与操作记录。
- `output/playwright/desktop-03/`：两页在360/768/1440宽度的截图、月视图、便签背面与异常状态。
- `output/playwright/desktop-05/verification.json`：本轮生成资产、点面翻转、键盘翻面、WebGL 与减少动态效果的实际检查结果。
- `output/playwright/desktop-05/`：本轮便签墙、翻面正反面、周日程和窄屏截图。
- `output/playwright/summer-scene/`：已回退的夏天窗外场景历史截图与循环变化验证，不属于当前页面。

总览 `index.html` 顶部可直接进入这两页。另外三套保留第四轮历史版本；内容已与当前拼贴不同，不作同条件评分。

## 历史材料

`ROUND-04.md` 与 `output/playwright/round4/` 保留第四轮说明和证据；`reviews/round3/REVIEW.md` 是第三轮三位独立评审的基线，不能当作当前版本评分。前三轮位于 `archive-v1/`、`archive-v2/`、`archive-v3/`。

所有本次修改均限于 `frontend-drafts/`。


## 侧边浏览器兼容（2026-11-19）

默认使用静态纸张与柔光背景，不启动持续 WebGL 循环；便签翻面、CSS 悬浮与任务操作保留。需要体验 WebGL 时显式添加 `?fx=on`（已有查询串时用 `&fx=on`）。入口脚本和样式统一携带 `v=desk-clean-2`，避免旧缓存与新入口混用。

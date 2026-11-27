# 截下来

把通知、截图和文字整理成任务，再把每天要做的工作排进日程。

| 要做什么 | 从这里开始 |
| --- | --- |
| 修改日程、任务、资料和规划助手 | [正式前端](frontend/src/) |
| 修改千问接入与分析服务 | [后端说明](backend/README.md) |
| 核对数据格式与演示样例 | [数据契约](contract/README.md) · [虚构样例](fixtures/) |
| 部署 Linux 或维护 Sites 转发 | [Linux 部署](deploy/linux/README.md) · [公网网关](deploy/public-gateway/) · [Sites 函数](frontend/functions/) |
| 查看比赛过程和站点验收 | [开发日志](devlog/README.md) · [协调与验收记录](devlog/coordination/) · [Sites 实测](output/sites-test-2026-11-26/) |
| 找已生成的交付物 | [Linux 发布包及校验文件](output/releases/) |
| 回看早期设计与审查 | [历史归档](archive/) |

## 历史文件在哪里

旧前端草案在 [frontend-drafts](archive/frontend-drafts/)，可独立运行的拼贴工作桌在 [collage-desk](archive/collage-desk/)。[接口联调台](archive/lab/) 和 [早期交接包](archive/handoff/) 也在归档内。

过往审查输出集中在 [archive/output](archive/output/)，少量原属前端子目录的输出位于 [archive/frontend/output](archive/frontend/output/)。归档保留原目录结构。读旧文档时，如果原路径已经移动，在项目根目录下给它加上 `archive/` 即可找到。部分旧验收脚本使用当时的绝对路径或相对导入，如需原样重跑，请在单独的项目副本中按原路径还原对应目录。

私有回归样本位于 [samples](samples/README.md)，原始验收素材位于 `devlog/private-evidence/`。比赛选图和打包请使用经过核对的材料。

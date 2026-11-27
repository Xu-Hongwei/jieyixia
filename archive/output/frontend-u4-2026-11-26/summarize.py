from pathlib import Path
import json
root=Path('output/playwright/frontend-u4-2026-11-26')
runs=['browser-final','workflow-final-r2','generation-quota-final','u1-regression-r2','u2-regression','u3-regression']
summary=[]
for run in runs:
 data=json.loads((root/run/'results.json').read_text(encoding='utf8'))
 summary.append({'run':run,'passed':sum(bool(r['pass']) for r in data['results']),'total':len(data['results']),'failed':[r for r in data['results'] if not r['pass']],'user_service_hits':len(data.get('netHits',[]))})
(root/'final-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
p=Path('devlog/coordination/2026-11-26-前端体验整理实施方案.md');s=p.read_text(encoding='utf-8-sig').replace('U0–U3 已实施并通过本地验收，U4–U5 待实施','U0–U4 已实施并通过本地验收，U5 待实施').replace('[U3 实施与验收](2026-11-26-前端U3实施与验收.md)。','[U3 实施与验收](2026-11-26-前端U3实施与验收.md)、[U4 实施与验收](2026-11-26-前端U4实施与验收.md)。').replace('本阶段交回，下一步为 U4：助手改为分步工作区。','U4 已完成助手分步工作区及未保存保护。本阶段交回，下一步为 U5：视觉统一、性能检查与最终交回。');p.write_text(s,encoding='utf8')

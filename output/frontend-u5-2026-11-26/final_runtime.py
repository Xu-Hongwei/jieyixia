from pathlib import Path
p=Path('output/playwright/frontend-u5-2026-11-26/runtime.mjs');s=p.read_text(encoding='utf8').replace("'runtime-final'","'runtime-final-r2'");s=s.replace("await shot(page,'cold-offline.png');", "rec('offline','断网时禁止重新加载，保留已打开的本地页面',await btn(page,'重试打开').isDisabled(),''); await shot(page,'cold-offline.png');");p.write_text(s,encoding='utf8')
p=Path('output/playwright/frontend-u5-2026-11-26/visual.mjs');s=p.read_text(encoding='utf8').replace("? 'before' : 'after-final'","? 'before' : 'after-final-r2'");p.write_text(s,encoding='utf8')

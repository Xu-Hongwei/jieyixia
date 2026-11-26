from pathlib import Path
out=Path('output/playwright/frontend-u5-2026-11-26')
p=out/'workflow.mjs';s=p.read_text(encoding='utf8').replace("'workflow-final-r2'","'workflow-final-r3'").replace("await boot(page);await nav(page,'助手').click()", "await boot(page);await nav(page,'助手').click();await waitText(page,'提供资料与需求')");p.write_text(s,encoding='utf8')
s=Path('output/frontend-u2-2026-11-26/extra.mjs').read_text(encoding='utf8');import re;s=re.sub(r"const RUN = join\(HERE, '[^']+'\)","const RUN = join(HERE, 'execution-extra')",s);(out/'execution-extra.mjs').write_text(s,encoding='utf8')
p=out/'visual.mjs';s=p.read_text(encoding='utf8').replace("? 'before' : 'after'","? 'before' : 'after-final'");p.write_text(s,encoding='utf8')

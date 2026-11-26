from pathlib import Path
out=Path('output/playwright/frontend-u4-2026-11-26');old=Path('output/playwright/frontend-u3-2026-11-26')
for name in ['u1-regression.mjs','u2-regression.mjs']:(out/name).write_text((old/name).read_text(encoding='utf8'),encoding='utf8')
s=(old/'accept.mjs').read_text(encoding='utf8').replace("'browser-final'","'u3-regression'")
s=s.replace("const goto=async(page,target)=>{await page.goto(BASE+'#'+target);await pause(page)}", "const goto=async(page,target)=>{await page.goto(BASE+'#'+target);await pause(page);const discard=page.getByRole('alertdialog').getByRole('button',{name:'放弃修改并继续',exact:true});if(await discard.count()){await discard.click();await pause(page)}}")
(out/'u3-regression.mjs').write_text(s,encoding='utf8')
s=(out/'workflow.mjs').read_text(encoding='utf8').replace("'workflow-r3'","'workflow-final'");(out/'workflow.mjs').write_text(s,encoding='utf8')

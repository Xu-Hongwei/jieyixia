from pathlib import Path
out=Path('output/playwright/frontend-u4-2026-11-26');out.mkdir(parents=True,exist_ok=True)
s=Path('output/playwright/frontend-u3-2026-11-26/u0-regression.mjs').read_text(encoding='utf8')
s=s.replace("'u0-regression'","'browser-r1'")
s=s.replace("const btn = (page, name) => page.getByRole('button', { name, exact: true })", "const btn = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true })")
# Determine exact helper declaration below if differs.
s=s.replace("async function setBudgets(page, minutes) {", "async function setBudgets(page, minutes) {\n  const details=page.locator('section[aria-label=\"核对建议\"] details').filter({has:page.getByText(/可用时间 ·/)}); if(!(await details.evaluate(e=>e.open)))await details.locator('summary').click()")
s=s.replace("await btn(page, '重新排程').click()", "await btn(page, '保存并预览').click()")
s=s.replace('七天预览（按日竖排）','每日安排')
s=s.replace("await page.locator('main li button').first().click()", "await page.getByText('继续已有草案（1）',{exact:true}).click(); await page.locator('main li button:visible').first().click()")
s=s.replace("await btn(page,'预览').click()", "await page.getByRole('navigation',{name:'规划步骤'}).getByRole('button',{name:/3 预览安排/}).click()")
s=s.replace("await btn(page,'编辑').click()", "await page.getByRole('navigation',{name:'规划步骤'}).getByRole('button',{name:/2 核对建议/}).click()")
# No preview exists yet: first compute through business actions before width checks.
s=s.replace("  for (const w of [360,390,430]) {\n    await checkWidth(page,'改排编辑',w)", "  await setBudgets(page,120); await confirmScopeTwice(page); await page.getByRole('navigation',{name:'规划步骤'}).getByRole('button',{name:/2 核对建议/}).click()\n  for (const w of [360,390,430]) {\n    await checkWidth(page,'改排编辑',w)")
s=s.replace("  await confirmScopeTwice(page)\n  await waitText(page,'就绪核对通过，可采用')", "  await page.getByRole('navigation',{name:'规划步骤'}).getByRole('button',{name:/3 预览安排/}).click()\n  await waitText(page,'就绪核对通过，可采用')\n  await btn(page,'下一步：确认加入').click()")
s=s.replace("  await btn(page,'载入演示：跨天周报').click()", "  await page.getByText('试试示例',{exact:true}).click(); await btn(page,'载入演示：跨天周报').click()")
s=s.replace('资料核对（独立于采用）','核对资料')
# demo may have preview precomputed; test later.
s=s.replace("} catch(e) {console.error(e);", "} catch(e) { for(const c of browser.contexts()) for(const p of c.pages()) {await shot(p,'failure.png');writeFileSync(join(RUN,'failure-body.txt'),await p.locator('body').innerText())}; console.error(e);")
(out/'accept.mjs').write_text(s,encoding='utf8')

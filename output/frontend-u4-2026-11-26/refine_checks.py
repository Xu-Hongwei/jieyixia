from pathlib import Path
p=Path('frontend/src/pages/AssistantPage.vue');s=p.read_text(encoding='utf8')
s=s.replace('v-show="tab === \'edit\' || tab === \'preview\'" class="space-y-2" aria-label="排程前核对"','v-show="(tab === \'edit\' || tab === \'preview\') && (replanScopeConf || deadlineConfirms.length || extraWorkPreConfirms.length || (tab === \'edit\' && otherBlockers.length))" class="space-y-2" aria-label="排程前核对"')
s=s.replace('<Alert v-if="!previewCurrent" variant="warning">','<Alert v-if="replanZeroNew" variant="warning">本次没有新安排，无法采用。请返回核对建议调整工作量或可用时间。</Alert>\n          <Alert v-if="!previewCurrent" variant="warning">')
p.write_text(s,encoding='utf8')
p=Path('frontend/src/components/assistant/PlanInput.vue');s=p.read_text(encoding='utf8')
s=s.replace('    const results', '    const results')
for start,end in [('  const results = await app.saveImageFiles','  } finally'),('  const r = await app.saveText','  } finally')]:
 a=s.index(start);b=s.index(end,a);s=s[:a]+''.join('  '+line+'\n' for line in s[a:b].splitlines())+s[b:]
s=s.replace('  if (!files.length) return','  if (!files.length || savingSource.value || store.generating) return')
s=s.replace(':disabled="store.generating" @click="fileInput',':disabled="store.generating || savingSource" @click="fileInput')
s=s.replace('const timeSummary = computed(() => dates.value.reduce((sum, date) => sum + (input.unavailable.includes(date) ? 0 : Number(input.budgets[date] || store.formDefaults.budget)), 0))', '''const timeSummary = computed(() => {
  const budgets = dates.value.map(date => input.unavailable.includes(date) ? 0 : Number(input.budgets[date] == null || input.budgets[date] === '' ? store.formDefaults.budget : input.budgets[date]))
  return budgets.every(n => Number.isInteger(n) && n >= 0 && n <= 1440) ? `${budgets.reduce((sum, n) => sum + n, 0)} 分钟` : '请检查时间输入'
})''').replace('共 {{ timeSummary }} 分钟','共 {{ timeSummary }}')
p.write_text(s,encoding='utf8')
p=Path('output/playwright/frontend-u4-2026-11-26/workflow.mjs');s=p.read_text(encoding='utf8').replace("'workflow-r2'","'workflow-r3'").replace("waitText(p,'核对与确认')","waitText(p,'← 返回列表')")
s=s.replace("async function confirmAll(page) {", "async function confirmAll(page) {\n  if(await btn(page,'确认 '+D(2)).count())await btn(page,'确认 '+D(2)).click()")
s=s.replace("await btn(page,'保存并预览').click();await waitText(page,'每日安排');await confirmAll(page)", "if(await btn(page,'确认 '+D(2)).count())await btn(page,'确认 '+D(2)).click(); await btn(page,'保存并预览').click();await waitText(page,'每日安排');await confirmAll(page)")
p.write_text(s,encoding='utf8')
p=Path('output/playwright/frontend-u4-2026-11-26/accept.mjs');s=p.read_text(encoding='utf8').replace("'browser-r2'","'browser-final'").replace("waitText(page,'核对与确认')","waitText(page,'← 返回列表')");p.write_text(s,encoding='utf8')

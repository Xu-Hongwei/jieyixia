from pathlib import Path
p=Path('frontend/src/pages/AssistantPage.vue');s=p.read_text(encoding='utf8')
a=s.index('          <div class="space-y-2" aria-label="排程前核对">');b=s.index('          <div class="flex justify-end border-t pt-4">',a)
checks=s[a:b].replace('class="space-y-2" aria-label=', 'v-show="tab === \'edit\' || tab === \'preview\'" class="space-y-2" aria-label=').replace('v-if="otherBlockers.length"','v-if="otherBlockers.length && tab === \'edit\'"')
s=s[:a]+s[b:]
a=s.index('          <div class="flex justify-end border-t pt-4">');b=s.index('          </fieldset>',a)
footer=s[a:b].replace('class="flex justify-end','v-show="tab === \'edit\'" class="flex justify-end')
s=s[:a]+s[b:]
pos=s.index('        <!-- 预览区 -->');s=s[:pos]+checks+footer+'\n'+s[pos:]
a=s.index('            <div v-if="replanScopeConf" class="mt-2 space-y-2 text-sm">');b=s.index('\n',a);s=s[:a]+s[b+1:]
# Avoid empty confirmation surfaces and make remaining blockers visible.
s=s.replace('<div class="rounded-lg border bg-card p-4">\n            <h3 class="text-sm font-semibold">核对与确认</h3>', '<div v-if="estimateUnknown.length || gapConfirms.length || overbookConfirms.length || extraWorkConfirms.length || readiness?.blockers?.length || canAdopt" class="space-y-2 border-b pb-4">\n            <h3 class="text-sm font-semibold">安排核对</h3>')
s=s.replace('v-if="otherBlockers.length" class="mt-2 list-disc pl-5 text-xs text-muted-foreground"','v-if="readiness?.blockers?.length" class="mt-2 list-disc pl-5 text-xs text-muted-foreground"').replace('v-for="(b, i) in otherBlockers" :key="i">{{ b.message }}</li>\n              </ul>','v-for="(b, i) in readiness.blockers" :key="i">{{ b.message }}</li>\n              </ul>')
s=s.replace("    tab.value = 'preview'\n  } finally", "    store.notice = null\n    tab.value = 'preview'\n  } finally")
p.write_text(s,encoding='utf8')
p=Path('output/playwright/frontend-u4-2026-11-26/workflow.mjs');s=p.read_text(encoding='utf8').replace("'workflow-r1'","'workflow-r2'").replace("btn(page,'返回列表')","btn(page,'← 返回列表')")
s=s.replace("await page.locator('body').innerText())", "await page.locator('body').innerText())")
s=s.replace("if(debugPage){await shot", "if(debugPage){console.log('STATE',await debugPage.evaluate(async()=>{const {useAssistantStore}=await import('/src/stores/assistant.js');const s=useAssistantStore();return {readiness:s.readiness,status:s.activeDraft?.status,stale:s.stale}}));await shot")
p.write_text(s,encoding='utf8')

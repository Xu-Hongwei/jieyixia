from pathlib import Path
p=Path('frontend/src/components/assistant/PlanInput.vue');s=p.read_text(encoding='utf8').replace("const timeOpen = ref(false)\n",'').replace(' :open="timeOpen" @toggle="timeOpen = $event.target.open"','');p.write_text(s,encoding='utf8')
p=Path('frontend/src/pages/AssistantPage.vue');s=p.read_text(encoding='utf8').replace('!!replanRef.value?.busy)','!!replanRef.value?.busy || !!inputRef.value?.busy)')
s=s.replace('<section v-show="tab === \'edit\'" class="space-y-5" aria-label="核对建议">','<section v-show="tab === \'edit\'" class="space-y-5" aria-label="核对建议">\n          <fieldset :disabled="workflowBusy" class="min-w-0 space-y-5">')
s=s.replace('        </section>\n\n        <!-- 预览区 -->','          </fieldset>\n        </section>\n\n        <!-- 预览区 -->')
s=s.replace('class="flex items-center gap-2 text-sm">\n                <span class="w-28','class="flex flex-wrap items-center gap-2 text-sm">\n                <span class="w-28')
# Do not allow revision-changing confirmations to replace unsaved content.
s=s.replace('@click="store.confirmDeadline',':disabled="!editable || contentDirty || workflowBusy" @click="store.confirmDeadline').replace(':disabled="!editable" :disabled=',':disabled=')
s=s.replace('@click="store.confirmReplanScope()"',':disabled="!editable || store.replanPanelDirty || workflowBusy" @click="store.confirmReplanScope()"').replace(':disabled="!editable" :disabled=',':disabled=')
s=s.replace('@click="store.confirmExtraWork(k)"',':disabled="!editable || contentDirty || store.replanPanelDirty || workflowBusy" @click="store.confirmExtraWork(k)"').replace(':disabled="!editable" :disabled=',':disabled=')
p.write_text(s,encoding='utf8')

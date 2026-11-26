from pathlib import Path
p=Path('frontend/src/pages/AssistantPage.vue')
s=p.read_text(encoding='utf-8')
a=s.index('async function saveChanges()'); b=s.index('async function openAdopt()')
part=s[a:b].replace('if (!p || saving) return','if (!p || saving) return false').replace('; return }','; return false }').replace('if (!r.ok) return','if (!r.ok) return false').replace('      return\n','      return false\n').replace('    initContent(false)','    initContent(false)\n    return true')
part=part.replace('    await store.reschedule({ startDate: start, budgets, unavailable: [...form.unavailable] })\n    return','    return (await store.reschedule({ startDate: start, budgets, unavailable: [...form.unavailable] })).ok')
part=part.replace('  await store.reschedule({ startDate: form.startDate || today.value, budgets, unavailable: [...form.unavailable] })','  return (await store.reschedule({ startDate: form.startDate || today.value, budgets, unavailable: [...form.unavailable] })).ok')
s=s[:a]+part+s[b:]
pos=s.index('\nconst threadTitle')
s=s[:pos]+'''
// 步骤只控制可见区域；事实确认、排程与采用仍由原服务判断。
const previewCurrent = computed(() => !!result.value && !store.stale && !contentDirty.value && !windowDirty.value && !store.replanPanelDirty)
const workflowBusy = computed(() => advancing.value || store.generating || Object.values(store.busy).some(Boolean) || !!replanRef.value?.busy)
const steps = [{ key: 'input', label: '提供资料' }, { key: 'edit', label: '核对建议' }, { key: 'preview', label: '预览安排' }, { key: 'adopt', label: '确认加入' }]
const stepEnabled = (key) => key === 'input' ? !draft.value : !!draft.value && (key === 'edit' || (key === 'preview' ? !!result.value : canAdopt.value || applied.value))
watch(() => draft.value?.id, () => { tab.value = applied.value ? 'adopt' : 'edit' })
watch(canAdopt, (ok) => {
  if (ok || applied.value) return
  adoptOpen.value = false
  if (tab.value === 'adopt') tab.value = result.value ? 'preview' : 'edit'
})
async function saveAndPreview() {
  if (!editable.value || workflowBusy.value) return
  if (store.replanPanelDirty) { store.say('warning', '请先保存改排内容，再预览安排。'); return }
  advancing.value = true
  try {
    if (!isReplan.value && contentDirty.value && !(await saveChanges())) return
    if (!(await reschedule())) return
    tab.value = 'preview'
  } finally { advancing.value = false }
}
const { discardOpen: leaveOpen, guardLeave, settle: settleLeave } = useUnsavedGuard(
  () => contentDirty.value || windowDirty.value || !!extraText.value.trim() || !!inputRef.value?.hasUnsaved || !!replanRef.value?.hasUnsaved,
  () => workflowBusy.value || ['save_failed', 'clarification'].includes(store.gen?.phase) || ['applying', 'result_unknown'].includes(draft.value?.status),
  () => { initContent(); initWindow(); extraText.value = ''; inputRef.value?.discard(); replanRef.value?.discard() },
)
const unregister = registerWorkLeave(guardLeave)
onBeforeUnmount(unregister)
onBeforeRouteLeave(requestWorkLeave)
onBeforeRouteUpdate(async (to, from) => {
  // 创建改排草案后的内部 URL 整理不丢输入；切换另一任务/资料才检查。
  if ((to.query.replanTask && to.query.replanTask !== from.query.replanTask) || (to.query.sources && JSON.stringify(to.query.sources) !== JSON.stringify(from.query.sources))) return guardLeave()
  return true
})
async function closeDraft() { if (await guardLeave()) store.close() }
async function chooseMode(mode) { if (entryMode.value !== mode && await guardLeave()) entryMode.value = mode }
async function openSaved(id) { if (await guardLeave()) await store.open(id) }
async function loadExample(name) { if (await guardLeave()) await store.loadDemo(name) }
''' +s[pos:]
s=s.replace('max-w-6xl','max-w-3xl')
a=s.index('    <Alert variant="info" class="flex items-center gap-2">');b=s.index('    <Alert v-if="app.aiDown"',a)
s=s[:a]+'''    <header class="space-y-4">
      <div><h1 class="text-2xl font-semibold">规划助手</h1><p class="mt-1 text-sm text-muted-foreground">把资料和想法，安排到每一天。</p></div>
      <nav aria-label="规划步骤" class="grid grid-cols-4 border-b">
        <button v-for="(step, i) in steps" :key="step.key" type="button" :disabled="!stepEnabled(step.key) || workflowBusy" :aria-current="(!draft ? step.key === 'input' : tab === step.key) ? 'step' : undefined" class="min-w-0 border-b-2 px-1 py-3 text-sm transition-colors disabled:cursor-default" :class="(!draft ? step.key === 'input' : tab === step.key) ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground enabled:hover:text-foreground disabled:opacity-45'" @click="tab = step.key"><span class="block text-xs sm:inline">{{ i + 1 }}</span> {{ step.label }}</button>
      </nav>
    </header>
''' +s[b:]
s=s.replace('<ReplanPanel :task-id="replanEntry"','<ReplanPanel ref="replanRef" :task-id="replanEntry"')
s=s.replace('@click="cancelReplanEntry"','@click="async () => { if (await guardLeave()) cancelReplanEntry() }"')
s=s.replace('        <PlanInput :key="app.workspaceId + materialInputRevision" />','''        <div class="flex gap-2" aria-label="规划类型">
          <Button :variant="entryMode === 'create' ? 'default' : 'outline'" :disabled="workflowBusy" @click="chooseMode('create')">制定新计划</Button>
          <Button :variant="entryMode === 'replan' ? 'default' : 'outline'" :disabled="workflowBusy" @click="chooseMode('replan')">调整已有计划</Button>
        </div>
        <PlanInput v-show="entryMode === 'create'" ref="inputRef" :key="app.workspaceId + materialInputRevision" />''')
s=s.replace('<div class="rounded-lg border bg-card p-4">\n          <h2 class="text-base font-semibold">调整已有任务（改排）</h2>','<div v-if="entryMode === \'replan\'" class="py-4">\n          <h2 class="text-base font-semibold">选择要调整的任务</h2>')
s=s.replace('一次只调整一个任务的后续安排：勾选允许替换的旧安排，填写本次工作量；总截止不变，受保护安排不动。','调整后续安排，保留任务总截止。')
s=s.replace('<div class="rounded-lg border bg-card p-4">\n          <h2 class="text-base font-semibold">开始</h2>','<details class="border-t pt-4">\n          <summary class="cursor-pointer text-sm font-medium">试试示例</summary>')
s=s.replace('载入虚构演示案例（在演示空间运行，与个人数据隔离），或继续本空间已有草案。','虚构案例将在独立演示空间打开。')
s=s.replace('@click="store.loadDemo(\'report\')"','@click="loadExample(\'report\')"').replace('@click="store.loadDemo(\'tight\')"','@click="loadExample(\'tight\')"')
s=s.replace('        </div>\n        <div class="rounded-lg border bg-card p-4">\n          <h2 class="text-base font-semibold">继续已有草案（{{ store.drafts.length }}）</h2>','        </details>\n        <details class="border-t pt-4">\n          <summary class="cursor-pointer text-sm font-medium">继续已有草案（{{ store.drafts.length }}）</summary>')
s=s.replace('          </ul>\n        </div>\n      </template>','          </ul>\n        </details>\n      </template>',1)
s=s.replace('@click="store.open(d.id)"','@click="openSaved(d.id)"').replace('@click="store.close()"','@click="closeDraft"')
s=s.replace('旧方案不能采用；请先「保存改排内容」并重新排程。','旧方案不能采用；请先保存改排内容，再预览安排。')
s=s.replace('请先「重新排程」。','请返回核对建议，保存并预览。').replace('请先「保存修改」并「重新排程」。','请返回核对建议，保存并预览。')
# Remove duplicate success area; keep non-success outcomes.
a=s.index('      <Alert v-if="outcome === \'committed\'');b=s.index('      <Alert v-else-if="outcome === \'needs_recheck\'"',a)
s=s[:a]+s[b:].replace('<Alert v-else-if="outcome === \'needs_recheck\'"','<Alert v-if="outcome === \'needs_recheck\'"',1)
a=s.index('      <!-- 移动端切换 -->');b=s.index('          <SourceReview',a)
s=s[:a]+'''      <div class="space-y-4">
        <section v-show="tab === 'edit'" class="space-y-5" aria-label="核对建议">
''' +s[b:]
s=s.replace('<ReplanPanel v-if="isReplan" :draft="draft" />','<ReplanPanel v-if="isReplan" ref="replanRef" :draft="draft" />')
s=s.replace('            <div class="mt-3 flex gap-2">\n              <Button :disabled="!editable || store.busy.saving || requiredMissing.length > 0" @click="saveChanges">保存修改</Button>\n            </div>','')
s=s.replace('          <div class="rounded-lg border bg-card p-4">\n            <h3 class="flex items-center gap-2 text-sm font-semibold"><CalendarCheck class="size-4" />排程窗口</h3>','          <details class="border-y py-4" :open="store.inputRestore === \'missing\' && !draft.planning_input">\n            <summary class="cursor-pointer text-sm font-semibold">可用时间 · {{ form.startDate }} 起七天 <span class="font-normal text-muted-foreground">编辑</span></summary>')
a=s.index('            <div class="mt-3 flex items-center gap-2">\n              <Button :disabled="!editable || store.busy.rescheduling"');b=s.index('          <div class="rounded-lg border bg-card p-4">',a)
s=s[:a]+'          </details>\n\n'+s[b:]
# Move pre-schedule confirmations to review; repeat scope confirmation in preview after revision bump.
a=s.index('            <!-- M3 替换范围确认');b=s.index('            <p v-if="!result"',a)
pre=s[a:b]
s=s[:a]+'''            <div v-if="replanScopeConf" class="mt-2 space-y-2 text-sm"><p>本版将替换 {{ replanScopeConf.replacement_ids.length }} 条旧安排；保留其余安排，总截止不变。</p><Button size="sm" variant="secondary" :disabled="!editable" @click="store.confirmReplanScope()">确认替换范围</Button></div>
''' +s[b:]
marker='        </section>\n\n        <!-- 预览区 -->'
s=s.replace(marker,'''          <div class="space-y-2" aria-label="排程前核对">
            <h3 class="text-sm font-semibold">核对与确认</h3>
'''+pre+'''            <ul v-if="otherBlockers.length && !result" class="list-disc pl-5 text-sm"><li v-for="(b, i) in otherBlockers" :key="i">{{ b.message }}</li></ul>
          </div>
          <div class="flex justify-end border-t pt-4"><Button :disabled="!editable || workflowBusy || requiredMissing.length > 0 || store.replanPanelDirty" @click="saveAndPreview">{{ advancing ? '正在准备预览…' : '保存并预览' }}</Button></div>
        </section>

        <!-- 预览区 -->''')
s=s.replace('<section :class="tab === \'preview\' ? \'space-y-4\' : \'hidden space-y-4 md:block\'">','<section v-show="tab === \'preview\'" class="space-y-4" aria-label="预览安排">\n          <Alert v-if="!previewCurrent" variant="warning">这是上一次预览，请返回核对建议更新后再采用。</Alert>')
s=s.replace('七天预览（按日竖排）','每日安排')
a=s.index('          <div class="rounded-lg border bg-card p-4">\n            <h3 class="text-sm font-semibold">采用</h3>')
s=s[:a]+'''          <div class="flex flex-wrap justify-between gap-2 border-t pt-4"><Button variant="outline" @click="tab = 'edit'">返回核对建议</Button><Button :disabled="!canAdopt" @click="tab = 'adopt'">下一步：确认加入</Button></div>
          <p v-if="!canAdopt" class="text-sm text-muted-foreground">请处理上方待确认项；修改任务或时间请返回核对建议。</p>
        </section>
        <section v-show="tab === 'adopt' && !applied" class="space-y-4" aria-label="确认加入">
''' +s[a:]
s=s.replace('<h3 class="text-sm font-semibold">采用</h3>','<h3 class="text-base font-semibold">将建议加入日程</h3>')
s=s.replace('一次保存为正式 Task / Action / PlanItem；重复点击不会重复写入。','确认后保存任务、行动和每日安排。')
s=s.replace('            <Button class="mt-2" :disabled="!canAdopt"','            <p class="mt-3 text-sm">{{ result?.segments?.length ?? 0 }} 条新安排<span v-if="isReplan">，替换 {{ replanView?.replacedCount ?? 0 }} 条旧安排</span><span v-if="result?.unscheduled?.length">，{{ result.unscheduled.length }} 项工作仍未排入</span>。</p>\n            <Button variant="outline" class="mr-2 mt-3" @click="tab = \'preview\'">返回预览安排</Button>\n            <Button class="mt-2" :disabled="!canAdopt"')
s=s.replace('    <ConfirmDialog v-model="discardOpen"','    <ConfirmDialog v-model="leaveOpen" title="放弃未保存的修改？" confirm-label="放弃修改并继续" cancel-label="继续编辑" @confirm="settleLeave(true)">已保存草案保留；当前未保存的输入将丢失。</ConfirmDialog>\n    <ConfirmDialog v-model="discardOpen"')
s=s.replace('CalendarCheck, ','')
p.write_text(s,encoding='utf-8')

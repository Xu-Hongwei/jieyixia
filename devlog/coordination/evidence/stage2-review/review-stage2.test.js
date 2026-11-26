import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from '../stores/app'
import { allDocs, putDoc } from '../services/storage/db'
import { noteBucket, rowMatches, sourceRow } from '../domains/organize'

it('审查：reviewed 不应掩盖 unresolved 的关键截止', () => {
  expect(noteBucket({status:'reviewed', fields:[{key:'deadline',status:'unresolved',value:null}]})).toBe('pending')
})

it('审查：确认删除应同步删除截止引用任务', async () => {
  setActivePinia(createPinia()); const s=useAppStore(); await s.init()
  await putDoc({id:'review-n1',kind:'note',title:'N',status:'draft',fields:[]})
  await putDoc({id:'review-t1',kind:'task',title:'T',status:'todo',note_ids:['review-n1'],deadline:{value:'2026-11-20',precision:'date',source:'note',from_note_id:'review-n1'}})
  await s.reload()
  expect((await s.deleteNote(s.notes.find(n=>n.id==='review-n1'))).ok).toBe(true)
  expect((await allDocs()).some(d=>d.id==='review-t1')).toBe(false)
})

it('审查：撤销删除不应覆盖删除之后用户已保存的任务修改', async () => {
  setActivePinia(createPinia()); const s=useAppStore(); await s.init()
  await putDoc({id:'review-n2',kind:'note',title:'N',status:'draft',fields:[]})
  await putDoc({id:'review-t2',kind:'task',title:'旧标题',status:'todo',note_ids:['review-n2'],deadline:null})
  await s.reload(); await s.deleteNote(s.notes.find(n=>n.id==='review-n2'))
  await s.renameTask(s.tasks.find(t=>t.id==='review-t2'),'用户新标题')
  await s.undoDelete()
  expect((await allDocs()).find(d=>d.id==='review-t2').title).toBe('用户新标题')
})

it('审查：本地搜索应该命中已提取字段原文', () => {
  expect(rowMatches(sourceRow({id:'s',kind:'image',name:'通知.png'},{title:'课程通知',status:'draft',fields:[{key:'requirement',raw:'必须提交纸质签字材料',value:'材料',status:'candidate'}]}),'纸质签字','all','all')).toBe(true)
})

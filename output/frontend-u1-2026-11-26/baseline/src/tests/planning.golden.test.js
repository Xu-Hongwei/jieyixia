// B1-01：23 份冻结金标输入调用真实 scheduleDaily，输出过独立校验器后与手算期望比对。
// 不是读 fixture 自己返回：segments/days/unscheduled/warnings/complete 全部来自算法真实运行。
// 金标 fixture 只作为数据读取（测试层），生产模块零 proposals 引用。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { scheduleDaily } from '../domains/planning/schedule.js'
import { validatePlanningResult } from '../domains/planning/validate.js'
import { segTuples, warningCodes } from './planning.helpers.js'

const FIX = new URL('../../../contract/proposals/assistant-v1/fixtures/', import.meta.url)
const load = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'))
const index = load('index.json')
const goldenFiles = index.cases.filter((c) => c.file.startsWith('g')).map((c) => c.file)
const byKey = (list) => [...list].sort((a, b) => (a.work_item_key < b.work_item_key ? -1 : 1))

describe('B1-01 冻结金标 × 真实 daily-v1', () => {
  it('金标数量与批次冻结一致（23 份，含 5B-1A 整改 g18–g20）', () => {
    expect(goldenFiles.length).toBe(23)
    for (const file of goldenFiles) {
      const f = load(file)
      expect(f.target).toBe('planning_golden')
      expect(f.implement_batch).toBe('5B-1')
    }
  })

  for (const file of goldenFiles) {
    const f = load(file)
    it(`${f.id}：真实排程 + 独立校验 + 期望比对 + 确定性 + 输入不可变`, () => {
      const input = structuredClone(f.payload.input)
      const before = structuredClone(input)
      const result = scheduleDaily(input)
      expect(input).toEqual(before)

      const aggregates = validatePlanningResult(input, result)
      expect(aggregates).toEqual({ ...f.expected, unscheduled: byKey(f.expected.unscheduled) })

      // 日期/分钟/顺序逐项比对（segment_key 是计算无关的注入字段，允许归一化）。
      expect(segTuples(result)).toEqual(segTuples(f.payload.result))
      expect(result.days).toEqual(f.payload.result.days)
      expect(byKey(result.unknown_items)).toEqual(byKey(f.payload.result.unknown_items))
      expect(byKey(result.excluded_items)).toEqual(byKey(f.payload.result.excluded_items))
      expect(warningCodes(result)).toEqual(warningCodes(f.payload.result))
      expect(result.complete).toBe(f.payload.result.complete)
      expect(result.unscheduled.map((u) => u.reason).sort())
        .toEqual(f.payload.result.unscheduled.map((u) => u.reason).sort())

      // 同输入必得同输出。
      expect(scheduleDaily(structuredClone(input))).toEqual(result)
    })
  }
})
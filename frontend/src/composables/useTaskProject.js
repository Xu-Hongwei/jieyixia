import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useAppStore } from '@/stores/app'

const tones = ['sage', 'lilac', 'blue', 'peach', 'rose', 'oat']

function toneIndex(id) {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % tones.length
}

export function projectTone(project) {
  return project?.id ? tones[toneIndex(project.id)] : 'neutral'
}

export const useTaskColors = defineStore('task-colors', () => {
  const store = useAppStore()
  const projects = computed(() => new Map(store.matters.map(project => [project.id, project])))
  const projectFor = task => projects.value.get(task?.matter_id)
  const independent = computed(() => {
    const tasks = store.docs.filter(d => d.kind === 'task' && !projectFor(d))
    tasks.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.id.localeCompare(b.id))
    const usage = tones.map(() => 0)
    const assigned = new Map()
    for (const task of tasks) {
      const lowest = Math.min(...usage)
      let index = toneIndex(task.id)
      while (usage[index] > lowest) index = (index + 1) % tones.length
      assigned.set(task.id, tones[index])
      usage[index]++
    }
    return assigned
  })
  function toneFor(task) {
    const project = projectFor(task)
    return project ? projectTone(project) : independent.value.get(task?.id) || 'neutral'
  }
  return { projectFor, toneFor }
})

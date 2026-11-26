import { request } from './http'
import { requestQwen } from './qwenConnection'

export const healthz = () => request('/api/healthz')
export const analyze = (payload, { signal = undefined } = {}) => requestQwen('analyze', payload, signal)
export const propose = (payload, { signal = undefined } = {}) => requestQwen('propose', payload, signal)

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
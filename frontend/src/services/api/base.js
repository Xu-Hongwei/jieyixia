const raw = import.meta.env.VITE_API_BASE ?? ''

export const API_BASE = raw.trim().replace(/\/+$/, '')

export const apiUrl = (path) => API_BASE + path

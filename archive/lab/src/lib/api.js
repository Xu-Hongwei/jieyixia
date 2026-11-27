export async function healthz() {
  const res = await fetch('/api/healthz')
  if (!res.ok) throw Object.assign(new Error('healthz failed'), { status: res.status })
  return res.json()
}

export async function analyze(payload, fail = null) {
  const url = '/api/analyze' + (fail ? `?fail=${fail}` : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

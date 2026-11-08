export const notePrefix = 'note:'

export async function request(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, ...payload })
  if (!response?.ok) throw new Error(response?.error || '页笺暂时无法访问本地存储')
  return response.data
}

export async function loadNotes() {
  const keys = (await chrome.storage.local.getKeys()).filter(key => key.startsWith(notePrefix))
  const entries = await chrome.storage.local.get(keys)
  return new Map(Object.entries(entries)
    .filter(([key]) => key.startsWith(notePrefix))
    .map(([, note]) => [note.id, note]))
}

export function blankNote() {
  return { id: crypto.randomUUID(), title: '', content: null, revision: 0, updatedAt: Date.now() }
}

export function label(note) {
  return note?.title.trim() || '无标题笔记'
}

export function plainText(node) {
  if (!node) return ''
  if (node.text != null) return node.text
  const separator = node.type === 'paragraph' || node.type === 'heading' ? '' : ' '
  return node.content?.map(plainText).join(separator) || ''
}

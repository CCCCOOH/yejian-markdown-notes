importScripts('image-storage.js')
const panelURL = chrome.runtime.getURL('panel.html')
const notePrefix = 'note:'
const tickets = new Map()
let mutationQueue = Promise.resolve()
let openingStandalone

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error)
chrome.action.onClicked.addListener(tab => void toggle(tab))

async function toggle(tab) {
  try {
    if (tab?.id == null) throw new Error('No active tab')
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] })
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }, { frameId: 0 })
    if (!response?.ok) throw new Error('Could not open the panel')
  } catch {
    await openStandalone().catch(console.error)
  }
}

function issueTicket(tabId) {
  const ticket = crypto.randomUUID()
  tickets.set(ticket, { tabId, expires: Date.now() + 15000 })
  for (const [key, value] of tickets) {
    if (value.expires < Date.now()) tickets.delete(key)
  }
  return ticket
}

function openStandalone() {
  if (openingStandalone) return openingStandalone
  openingStandalone = (async () => {
    const { standaloneWindow } = await chrome.storage.session.get('standaloneWindow')
    if (standaloneWindow != null) {
      const existing = await chrome.windows.get(standaloneWindow).catch(() => null)
      if (existing) {
        await chrome.windows.update(existing.id, { focused: true })
        return
      }
    }
    const win = await chrome.windows.create({
      url: panelURL + '#' + issueTicket(null),
      type: 'popup',
      width: 790,
      height: 630,
    })
    await chrome.storage.session.set({ standaloneWindow: win.id })
  })().finally(() => { openingStandalone = null })
  return openingStandalone
}

chrome.windows.onRemoved.addListener(async id => {
  const { standaloneWindow } = await chrome.storage.session.get('standaloneWindow')
  if (id === standaloneWindow) await chrome.storage.session.remove('standaloneWindow')
})

function enqueueMutation(operation) {
  const result = mutationQueue.then(operation)
  mutationQueue = result.catch(() => {})
  return result
}

async function saveNote(note, revision) {
  const key = notePrefix + note.id
  const existing = (await chrome.storage.local.get(key))[key]
  const conflict = (existing?.revision ?? 0) !== revision
  const saved = {
    id: conflict ? crypto.randomUUID() : note.id,
    title: conflict ? (note.title.trim() || '无标题笔记') + '（冲突副本）' : note.title,
    content: note.content,
    revision: conflict ? 1 : revision + 1,
    updatedAt: Date.now(),
  }
  await chrome.storage.local.set({ [notePrefix + saved.id]: saved })
  return saved
}

async function deleteNote(id, revision) {
  const key = notePrefix + id
  const existing = (await chrome.storage.local.get(key))[key]
  if (existing && existing.revision !== revision) return { changed: true, note: existing }
  await chrome.storage.local.remove(key)
  return { changed: false }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message) return
  const fromPanel = sender.url?.split('#')[0] === panelURL
  const fromPage = !fromPanel && sender.tab?.id != null && sender.frameId === 0
  let operation
  if (fromPage && message.type === 'prepare-panel') {
    operation = chrome.storage.local.get(['bounds', 'ringPosition']).then(({ bounds, ringPosition }) => ({
      ticket: issueTicket(sender.tab.id), bounds, ringPosition,
    }))
  } else if (fromPage && message.type === 'store-ring') {
    operation = chrome.storage.local.set({ ringPosition: message.position })
  } else if (fromPage && message.type === 'store-bounds') {
    operation = chrome.storage.local.set({ bounds: message.bounds })
  } else if (fromPage && message.type === 'open-standalone') {
    operation = openStandalone()
  } else if (fromPanel && message.type === 'connect-panel') {
    const ticket = tickets.get(message.ticket)
    const matches = sender.frameId === 0
      ? ticket?.tabId === null
      : ticket?.tabId === sender.tab?.id
    if (!ticket || ticket.expires < Date.now() || !matches) {
      respond({ ok: false })
      return
    }
    tickets.delete(message.ticket)
    respond({ ok: true })
    return
  } else if (fromPanel && message.type === 'save-image') {
    operation = Promise.resolve().then(() => saveImage(message))
  } else if (fromPanel && message.type === 'retry-image') {
    operation = writeImage(message.id)
  } else if (fromPanel && message.type === 'set-image-folder') {
    operation = Promise.resolve().then(() =>
      chrome.storage.local.set({ imageFolder: validImageFolder(message.folder) }))
  } else if (fromPanel && message.type === 'save-note') {
    operation = enqueueMutation(() => saveNote(message.note, message.revision))
  } else if (fromPanel && message.type === 'delete-note') {
    operation = enqueueMutation(() => deleteNote(message.id, message.revision))
  } else {
    return
  }
  operation.then(data => respond({ ok: true, data }), error => {
    respond({ ok: false, error: error.message })
  })
  return true
})

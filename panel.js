import { initializeTheme } from './theme.js'
import { LocalImage, pasteImages, defaultImageFolder, prepareImageCopy } from './images.js'
import { Editor, StarterKit, Markdown, TaskList, TaskItem, TableKit } from './vendor/editor.js'
import { request, loadNotes, notePrefix, blankNote, label, plainText } from './notes.js'

const $ = id => document.getElementById(id)
const embedded = window.parent !== window
const small = matchMedia('(max-width: 595px)')
const pending = new Map()
const toolbar = $('toolbar')
const styleSelect = $('block-style')
const more = $('more-menu')
const titleInput = $('note-title')
const searchInput = $('search')
const editorElement = $('editor')
const deleteDialog = $('delete-dialog')
const linkDialog = $('link-dialog')
const copyDialog = $('copy-dialog')
const emptyDocument = { type: 'doc', content: [{ type: 'paragraph' }] }
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
const allowedURL = /^(https?:\/\/|mailto:)/i
const markdownText = /(^|\n)\s*(?:#{1,6}\s|(?:[-+*]|\d+\.)\s|>\s?|```|~~~|[-*_]{3,}\s*$|\|.+\|)|(?:\*\*|__|~~|`)[^\n]+(?:\*\*|__|~~|`)|\[[^\]\n]+\]\([^\s)]+\)/m
const actions = {
  bold: 'toggleBold', italic: 'toggleItalic', strike: 'toggleStrike',
  bulletList: 'toggleBulletList', orderedList: 'toggleOrderedList', taskList: 'toggleTaskList',
  blockquote: 'toggleBlockquote', code: 'toggleCode', codeBlock: 'toggleCodeBlock',
  horizontalRule: 'setHorizontalRule', insertTable: 'insertTable',
  addRowAfter: 'addRowAfter', addColumnAfter: 'addColumnAfter',
  deleteRow: 'deleteRow', deleteColumn: 'deleteColumn', deleteTable: 'deleteTable',
}
let imageFolder = defaultImageFolder
let saved
let draft
let activeId
let editor
let toastTimer
let copyTimer
let deleteId
let deleteRevision
let linkTarget

function noteFor(id) {
  return pending.get(id)?.latest ?? (draft?.id === id ? draft : saved.get(id))
}

function sortedNotes() {
  const notes = new Map(saved)
  if (draft) notes.set(draft.id, draft)
  for (const [id, job] of pending) notes.set(id, job.latest)
  return [...notes.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

function announce(message) {
  clearTimeout(toastTimer)
  $('toast').textContent = message
  $('toast').hidden = false
  toastTimer = setTimeout(() => { $('toast').hidden = true }, 3000)
}

function renderList() {
  const notes = sortedNotes()
  const query = searchInput.value.trim().toLocaleLowerCase()
  const matching = notes.filter(note =>
    (label(note) + ' ' + plainText(note.content)).toLocaleLowerCase().includes(query))
  const fragment = document.createDocumentFragment()
  for (const note of matching) {
    const button = document.createElement('button')
    button.className = 'note-card'
    button.dataset.id = note.id
    if (note.id === activeId) button.setAttribute('aria-current', 'true')
    const heading = document.createElement('strong')
    heading.textContent = label(note)
    const preview = document.createElement('small')
    preview.textContent = plainText(note.content).trim() ||
      (note.revision ? dateFormat.format(note.updatedAt) : '新笔记')
    button.append(heading, preview)
    fragment.append(button)
  }
  if (!matching.length) {
    const empty = document.createElement('p')
    empty.className = 'list-empty'
    empty.textContent = query ? '没有找到匹配的笔记' : '还没有笔记'
    fragment.append(empty)
  }
  const focused = document.activeElement?.dataset.id
  $('note-list').replaceChildren(fragment)
  if (focused) $('note-list').querySelector('[data-id="' + focused + '"]')?.focus({ preventScroll: true })
}

function renderStatus() {
  const note = noteFor(activeId)
  const job = pending.get(activeId)
  const state = job ? (job.failed ? 'error' : 'saving') : (note?.revision ? 'saved' : 'draft')
  $('save-status').dataset.state = state
  $('save-label').textContent = { draft: '新笔记', saved: '已保存', saving: '保存中', error: '保存失败' }[state]
  $('retry-save').hidden = state !== 'error'
  $('delete-note').disabled = state === 'saving' || !note?.revision
}

function renderEditorStatus() {
  editorElement.classList.toggle('empty', editor.isEmpty)
  $('copy-note').disabled = editor.isEmpty && !titleInput.value.trim()
}

function renderFormats() {
  if (!editor) return
  styleSelect.value = editor.getAttributes('heading').level || '0'
  for (const button of toolbar.querySelectorAll('.format-button[data-action]')) {
    button.setAttribute('aria-pressed', String(editor.isActive(button.dataset.action)))
  }
  for (const button of toolbar.querySelectorAll('[data-table]')) {
    button.hidden = !editor.isActive('table')
  }
}

function updateNote(change) {
  const note = noteFor(activeId)
  const job = pending.get(activeId) ?? { revision: note.revision, latest: note }
  job.latest = { ...job.latest, ...change, updatedAt: Date.now() }
  pending.set(activeId, job)
  renderList()
  renderStatus()
  renderEditorStatus()
  if (!job.running) void persist(job)
}

async function persist(job) {
  job.running = true
  job.failed = false
  renderStatus()
  while (true) {
    const sent = job.latest
    let result
    try {
      result = await request('save-note', { note: sent, revision: job.revision })
    } catch {
      job.running = false
      job.failed = true
      renderStatus()
      return
    }
    const newerEdit = job.latest !== sent
    if (draft?.id === sent.id) draft = null
    if ((saved.get(result.id)?.revision ?? 0) < result.revision) saved.set(result.id, result)
    pending.delete(sent.id)
    job.revision = result.revision
    if (result.id !== sent.id) {
      if (activeId === sent.id) {
        activeId = result.id
        if (titleInput.value === sent.title) titleInput.value = result.title
      }
      announce('另一窗口也修改了这条笔记，当前编辑已保存为副本。')
    }
    if (!newerEdit) {
      job.running = false
      const latestSaved = saved.get(result.id)
      if (activeId === result.id && latestSaved?.revision > result.revision) {
        openNote(result.id)
      }
      renderList()
      renderStatus()
      return
    }
    job.latest = {
      ...job.latest, id: result.id, revision: result.revision,
      title: job.latest.title === sent.title ? result.title : job.latest.title,
    }
    pending.set(result.id, job)
    renderList()
  }
}

function openNote(id, focus = false) {
  const note = noteFor(id)
  if (!note) return
  activeId = note.id
  titleInput.value = note.title
  editor?.destroy()
  editor = new Editor({
    element: editorElement,
    injectCSS: false,
    content: note.content || emptyDocument,
    extensions: [
      StarterKit.configure({
        underline: false,
        link: {
          openOnClick: false,
          isAllowedUri: (url, context) => allowedURL.test(url) && context.defaultValidate(url),
        },
      }),
      LocalImage,
      TaskList, TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { renderWrapper: true } }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Markdown 正文', 'aria-multiline': 'true', spellcheck: 'false' },
      handlePaste(_view, event) {
        const data = event.clipboardData
        const images = [...(data?.files || [])].filter(file => file.type.startsWith('image/'))
        if (images.length) {
          pasteImages(images, editor, imageFolder, announce)
          return true
        }
        const text = data?.getData('text/plain')
        if (!text || data.getData('text/html') || editor.isActive('codeBlock') || !markdownText.test(text)) return false
        try {
          return editor.commands.insertContent(text, { contentType: 'markdown' })
        } catch {
          return false
        }
      },
      handleClick(_view, _pos, event) {
        const link = event.target.closest('a[href]')
        if (!link || (!event.metaKey && !event.ctrlKey) || !allowedURL.test(link.href)) return false
        window.open(link.href, '_blank', 'noopener,noreferrer')
        return true
      },
    },
    onUpdate: ({ editor: changed }) => updateNote({ content: changed.getJSON() }),
    onTransaction: renderFormats,
  })
  $('paper-scroll').scrollTop = 0
  renderList()
  renderStatus()
  renderFormats()
  renderEditorStatus()
  if (focus) titleInput.focus()
}

function newNote(focus = false) {
  draft ??= blankNote()
  searchInput.value = ''
  openNote(draft.id, focus)
  if (small.matches) setLibrary(false)
}

function setLibrary(open) {
  $('library').hidden = !open
  $('toggle-library').setAttribute('aria-expanded', String(open))
  $('drawer-shade').hidden = !open || !small.matches
}

function updateFromStorage(changes, area) {
  if (area !== 'local') return
  if (changes.imageFolder) imageFolder = changes.imageFolder.newValue || defaultImageFolder
  let listChanged = false
  for (const [key, { oldValue, newValue }] of Object.entries(changes)) {
    if (!key.startsWith(notePrefix)) continue
    const id = key.slice(notePrefix.length)
    if (newValue) saved.set(id, newValue)
    else saved.delete(id)
    listChanged = true
    if (id === activeId && !pending.has(id)) {
      if (!newValue) {
        const next = sortedNotes()[0]
        if (next) openNote(next.id)
        else newNote()
      } else if (newValue.revision !== oldValue?.revision) {
        openNote(id)
      }
    }
  }
  if (listChanged) renderList()
}

function showLinkDialog() {
  const { from, to } = editor.state.selection
  linkTarget = { editor, from, to }
  $('link-text').value = editor.state.doc.textBetween(from, to, ' ')
  $('link-url').value = editor.getAttributes('link').href || ''
  $('link-error').hidden = true
  linkDialog.showModal()
  $('link-url').focus({ preventScroll: true })
}

function applyLink(event) {
  event.preventDefault()
  let url
  const input = $('link-url').value.trim()
  try {
    if (!input) throw new Error('Empty URL')
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : 'https://' + input).href
    if (!allowedURL.test(url)) throw new Error('Unsupported URL')
  } catch {
    $('link-error').hidden = false
    return
  }
  linkDialog.close()
  if (linkTarget.editor !== editor) return
  const { from, to } = linkTarget
  const text = $('link-text').value.trim()
  const chain = editor.chain().focus().setTextSelection({ from, to })
  if (from === to && editor.isActive('link')) {
    chain.extendMarkRange('link').setLink({ href: url }).run()
  } else if (from === to || (text && text !== editor.state.doc.textBetween(from, to, ' '))) {
    chain.insertContent({ type: 'text', text: text || url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
  } else {
    chain.setLink({ href: url }).run()
  }
}

async function copyNote() {
  try { await prepareImageCopy(editor.getJSON()) }
  catch (error) { announce(error.message); return }
  const title = titleInput.value.trim().replace(/[\\`*_[\]<>#]/g, '\\$&')
  const body = editor.getMarkdown()
  const markdown = [title && '# ' + title, body].filter(Boolean).join('\n\n')
  const previousFocus = document.activeElement
  const field = document.createElement('textarea')
  field.value = markdown
  field.style.cssText = 'position:fixed;top:0;left:-10000px'
  document.body.append(field)
  field.select()
  let copied = false
  try { copied = document.execCommand('copy') } catch {}
  field.remove()
  previousFocus?.focus({ preventScroll: true })
  if (!copied) {
    try {
      await navigator.clipboard.writeText(markdown)
      copied = true
    } catch {}
  }
  if (!copied) {
    $('copy-text').value = markdown
    copyDialog.showModal()
    $('copy-text').select()
    return
  }
  $('copy-label').textContent = '已复制'
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { $('copy-label').textContent = '复制 Markdown' }, 1300)
}

function sendToHost(type, event) {
  window.parent.postMessage({
    channel: 'yejian-panel', type, x: event?.screenX, y: event?.screenY,
  }, '*')
}

function bindGesture(handle, type) {
  let pointer
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || event.target.closest('button')) return
    event.preventDefault()
    pointer = event.pointerId
    handle.setPointerCapture(pointer)
    sendToHost(type, event)
  })
  handle.addEventListener('pointermove', event => {
    if (event.pointerId === pointer) sendToHost('gesture-move', event)
  })
  handle.addEventListener('lostpointercapture', event => {
    if (event.pointerId !== pointer) return
    pointer = undefined
    sendToHost('gesture-end')
  })
}

function closePanel() {
  if (embedded) sendToHost('close')
  else window.close()
}

function bindEvents() {
  if (embedded) {
    bindGesture($('drag-handle'), 'drag-start')
    bindGesture($('resize-handle'), 'resize-start')
  } else {
    document.body.classList.add('standalone')
    $('close-panel').setAttribute('aria-label', '关闭笔记窗口')
    $('close-panel').title = '关闭笔记窗口 (Esc)'
  }
  $('close-panel').addEventListener('click', closePanel)
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
    if (more.open) more.open = false
    else if (small.matches && !$('library').hidden) setLibrary(false)
    else closePanel()
  })
  $('toggle-library').addEventListener('click', () => setLibrary($('library').hidden))
  $('drawer-shade').addEventListener('click', () => setLibrary(false))
  small.addEventListener('change', event => setLibrary(!event.matches))
  $('new-note').addEventListener('click', () => newNote(true))
  searchInput.addEventListener('input', renderList)
  $('note-list').addEventListener('click', event => {
    const button = event.target.closest('.note-card')
    if (!button) return
    if (button.dataset.id !== activeId) openNote(button.dataset.id)
    if (small.matches) {
      setLibrary(false)
      titleInput.focus()
    }
  })
  titleInput.addEventListener('input', () => updateNote({ title: titleInput.value }))
  titleInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) editor.commands.focus('start')
  })
  styleSelect.addEventListener('change', () => {
    const level = Number(styleSelect.value)
    const chain = editor.chain().focus()
    if (level) chain.setHeading({ level }).run()
    else chain.setParagraph().run()
  })
  toolbar.addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault()
  })
  toolbar.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]')
    if (!button) return
    const action = button.dataset.action
    more.open = false
    if (action === 'imageFolder') {
      $('image-folder').value = imageFolder
      $('image-folder-error').hidden = true
      $('image-folder-dialog').showModal()
    } else if (action === 'link') showLinkDialog()
    else if (action === 'insertTable') editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    else editor.chain().focus()[actions[action]]().run()
  })
  document.addEventListener('pointerdown', event => {
    if (!more.contains(event.target)) more.open = false
  })
  $('image-folder-form').addEventListener('submit', async event => {
    event.preventDefault()
    try {
      await request('set-image-folder', { folder: $('image-folder').value })
      $('image-folder-dialog').close()
    } catch (error) {
      $('image-folder-error').textContent = error.message
      $('image-folder-error').hidden = false
    }
  })
  $('cancel-image-folder').addEventListener('click', () => $('image-folder-dialog').close())
  $('link-form').addEventListener('submit', applyLink)
  $('cancel-link').addEventListener('click', () => linkDialog.close())
  $('copy-note').addEventListener('click', copyNote)
  $('retry-save').addEventListener('click', () => {
    const job = pending.get(activeId)
    if (job && !job.running) void persist(job)
  })
  $('delete-note').addEventListener('click', () => {
    deleteId = activeId
    deleteRevision = saved.get(deleteId)?.revision
    deleteDialog.returnValue = ''
    $('delete-description').textContent = '「' + label(noteFor(deleteId)) + '」将从本机删除。'
    deleteDialog.showModal()
    deleteDialog.querySelector('button[value="cancel"]').focus({ preventScroll: true })
  })
  deleteDialog.addEventListener('close', async () => {
    const id = deleteId
    if (deleteDialog.returnValue !== 'delete' || !saved.has(id)) return
    const revision = deleteRevision
    try {
      const result = await request('delete-note', { id, revision })
      if (result.changed) {
        announce('笔记刚在另一窗口更新，请确认内容后再删除。')
        return
      }
      pending.delete(id)
      saved.delete(id)
      if (activeId === id) {
        const next = sortedNotes()[0]
        if (next) openNote(next.id)
        else newNote()
      }
      renderList()
      announce('已删除笔记')
    } catch {
      announce('删除失败，请重试。')
    }
  })
}

async function start() {
  const ticket = location.hash.slice(1)
  if (!ticket) throw new Error('Missing ticket')
  await request('connect-panel', { ticket })
  history.replaceState(null, '', location.pathname)
  imageFolder = (await chrome.storage.local.get('imageFolder')).imageFolder || defaultImageFolder
  await initializeTheme()
  saved = await loadNotes()
  const first = sortedNotes()[0]
  if (first) openNote(first.id)
  else newNote()
  bindEvents()
  setLibrary(!small.matches)
  chrome.storage.onChanged.addListener(updateFromStorage)
  $('loading').hidden = true
  $('app').hidden = false
  if (embedded) sendToHost('ready')
}

start().catch(() => {
  $('loading').textContent = '请通过浏览器工具栏的「页笺」图标打开笔记。'
})

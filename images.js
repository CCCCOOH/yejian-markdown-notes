import { Image } from './vendor/editor.js'
import { request } from './notes.js'

export const defaultImageFolder = '页笺/images'
export const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const copyPaths = new Map()

export async function prepareImageCopy(doc) {
  const ids = new Set()
  function visit(node) {
    if (node.type === 'image' && node.attrs?.assetId) ids.add(node.attrs.assetId)
    node.content?.forEach(visit)
  }
  visit(doc)
  const entries = await chrome.storage.local.get([...ids].map(id => 'image:' + id))
  copyPaths.clear()
  for (const id of ids) {
    const asset = entries['image:' + id]
    if (asset?.state !== 'saved' || !asset.path) throw new Error('图片尚未保存，请完成保存后再复制。')
    const path = asset.path.replaceAll('\\', '/')
    copyPaths.set(id, encodeURI('file://' + (path.startsWith('/') ? '' : '/') + path).replaceAll('#', '%23').replaceAll('?', '%3F'))
  }
}

export const LocalImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), assetId: { default: null, rendered: false } }
  },
  renderMarkdown(node) {
    const src = copyPaths.get(node.attrs.assetId) || node.attrs.src
    const alt = (node.attrs.alt || '图片').replace(/[[\]\\]/g, '\\$&')
    return '![' + alt + '](<' + src + '>)'
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('figure')
      dom.className = 'note-image'
      dom.contentEditable = 'false'
      const img = document.createElement('img')
      img.alt = node.attrs.alt || '图片'
      const status = document.createElement('button')
      status.type = 'button'
      status.textContent = '正在保存图片…'
      status.disabled = true
      dom.append(img, status)
      const key = 'image:' + node.attrs.assetId
      let destroyed = false
      const pendingTimer = setTimeout(() => {
        if (!destroyed && !status.hidden && status.disabled) {
          status.disabled = false
          status.textContent = '保存未完成，点击重试'
        }
      }, 30000)
      function render(asset) {
        if (destroyed) return
        if (asset?.dataUrl) img.src = asset.dataUrl
        status.hidden = asset?.state === 'saved'
        status.disabled = asset?.state !== 'failed'
        status.textContent = asset?.state === 'failed' ? '保存失败，点击重试' : '正在保存图片…'
        if (!node.attrs.assetId) {
          status.textContent = '请复制图片后粘贴到笔记'
          img.removeAttribute('src')
        }
      }
      const change = (changes, area) => {
        if (area === 'local' && changes[key]) render(changes[key].newValue)
      }
      chrome.storage.onChanged.addListener(change)
      chrome.storage.local.get(key).then(data => render(data[key]))
      status.addEventListener('click', async () => {
        status.disabled = true
        status.textContent = '正在保存图片…'
        try { await request('retry-image', { id: node.attrs.assetId }) }
        catch { render({ state: 'failed' }) }
      })
      return {
        dom,
        stopEvent: () => true,
        ignoreMutation: () => true,
        destroy() { destroyed = true; clearTimeout(pendingTimer); chrome.storage.onChanged.removeListener(change) },
      }
    }
  },
})

export function pasteImages(files, editor, folder, announce) {
  const accepted = files.filter(file => imageTypes[file.type])
  if (accepted.length !== files.length) announce('支持粘贴 PNG、JPEG、WebP 和 GIF 图片。')
  for (const file of accepted) {
    if (file.size > 12 * 1024 * 1024) {
      announce('单张图片请控制在 12 MB 以内。')
      continue
    }
    const id = crypto.randomUUID()
    const filename = folder + '/' + id + '.' + imageTypes[file.type]
    editor.commands.insertContent({ type: 'image', attrs: { assetId: id, src: filename, alt: '图片' } })
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        await request('save-image', { id, filename, dataUrl: reader.result })
      } catch (error) {
        announce(error.message || '图片保存失败，请点击图片下方重试。')
      }
    }
    reader.onerror = () => {
      chrome.storage.local.set({ ['image:' + id]: { state: 'failed', error: '无法读取剪贴板图片' } })
      announce('无法读取图片，请重新复制后粘贴。')
    }
    reader.readAsDataURL(file)
  }
}

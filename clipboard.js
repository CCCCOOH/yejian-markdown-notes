// Supply rich HTML with embedded image bytes, plus a Markdown text fallback.
export async function buildClipboardContent(editor, title) {
  const doc = structuredClone(editor.getJSON())
  const imageNodes = []
  function visit(node) {
    if (node.type === 'image') imageNodes.push(node)
    node.content?.forEach(visit)
  }
  visit(doc)
  const htmlDoc = new DOMParser().parseFromString(editor.getHTML(), 'text/html')
  const images = [...htmlDoc.querySelectorAll('img')]
  const dataUrls = []
  for (let i = 0; i < imageNodes.length; i++) {
    const node = imageNodes[i]
    const asset = node.attrs?.assetId
      ? (await chrome.storage.local.get('image:' + node.attrs.assetId))['image:' + node.attrs.assetId] : null
    const source = asset?.dataUrl || node.attrs?.src
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(source || '')) throw new Error('图片尚未就绪，请稍后再复制。')
    dataUrls.push(source)
    images[i].setAttribute('src', source)
    images[i].style.maxWidth = '100%'
    // The plain-text representation is portable too; no local file dependency.
    node.attrs = { ...node.attrs, assetId: null, src: source }
  }
  if (title) {
    const heading = htmlDoc.createElement('h1')
    heading.textContent = title
    htmlDoc.body.prepend(heading)
  }
  const escapedTitle = title.replace(/[\\`*_[\]<>#]/g, '\\$&')
  const markdown = [escapedTitle && '# ' + escapedTitle, editor.markdown.serialize(doc)].filter(Boolean).join('\n\n')
  const content = { markdown, html: htmlDoc.body.innerHTML }
  // Image-only destinations can also paste a single image directly.
  if (dataUrls.length === 1) {
    const bytes = Uint8Array.from(atob(dataUrls[0].split(',')[1]), c => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: dataUrls[0].slice(5, dataUrls[0].indexOf(';')) })
    if (blob.type === 'image/png') content.png = blob
    else {
      const bitmap = await createImageBitmap(blob)
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        content.png = await canvas.convertToBlob({ type: 'image/png' })
      } finally { bitmap.close() }
    }
  }
  return content
}

export async function writeNoteClipboard(content) {
  try {
    const types = {
      'text/plain': new Blob([content.markdown], { type: 'text/plain' }),
      'text/html': new Blob([content.html], { type: 'text/html' }),
    }
    if (content.png) types['image/png'] = content.png
    await navigator.clipboard.write([new ClipboardItem(types)])
    return true
  } catch {}
  // Cross-origin clipboard policies may block the async API. The user-triggered
  // copy event still supports HTML, rather than silently dropping the images.
  const previousFocus = document.activeElement
  const selection = window.getSelection()
  const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
  const field = document.createElement('textarea')
  field.value = content.markdown
  field.style.cssText = 'position:fixed;left:-10000px;top:0'
  document.body.append(field)
  field.select()
  const onCopy = event => {
    event.preventDefault()
    event.clipboardData.setData('text/plain', content.markdown)
    event.clipboardData.setData('text/html', content.html)
  }
  document.addEventListener('copy', onCopy)
  try { return document.execCommand('copy') }
  catch { return false }
  finally {
    document.removeEventListener('copy', onCopy)
    field.remove()
    previousFocus?.focus({ preventScroll: true })
    selection.removeAllRanges()
    for (const range of ranges) selection.addRange(range)
  }
}

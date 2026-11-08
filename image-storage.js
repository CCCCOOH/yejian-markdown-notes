const imageJobs = new Map()

function validImageFolder(value) {
  if (typeof value !== 'string') throw new Error('请输入下载目录内的文件夹名称。')
  const folder = value.trim().replaceAll('\\', '/')
  if (!folder || folder.length > 180 || folder.split('/').some(part =>
    !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    throw new Error('请填写有效的相对子目录，例如 页笺/images。')
  }
  return folder
}

function saveImage(message) {
  if (!/^[a-f0-9-]{36}$/.test(message.id)) throw new Error('图片标识无效')
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(message.dataUrl) ||
      message.dataUrl.length > 17 * 1024 * 1024) throw new Error('图片格式或大小不支持')
  const slash = message.filename?.lastIndexOf('/')
  if (slash < 1 || !new RegExp('^' + message.id + '\\.(png|jpg|webp|gif)$').test(message.filename.slice(slash + 1))) {
    throw new Error('图片文件名无效')
  }
  validImageFolder(message.filename.slice(0, slash))
  return writeImage(message.id, { dataUrl: message.dataUrl, filename: message.filename })
}

function writeImage(id, initial) {
  if (imageJobs.has(id)) return imageJobs.get(id)
  const job = (async () => {
    const key = 'image:' + id
    const asset = initial || (await chrome.storage.local.get(key))[key]
    if (!asset?.dataUrl || !asset.filename) throw new Error('请重新复制并粘贴这张图片。')
    await chrome.storage.local.set({ [key]: { ...asset, state: 'saving' } })
    try {
      const previous = asset.downloadId == null ? null :
        (await chrome.downloads.search({ id: asset.downloadId }))[0]
      const downloadId = previous && previous.state !== 'interrupted' && previous.exists !== false
        ? previous.id : await chrome.downloads.download({
        url: asset.dataUrl, filename: asset.filename, saveAs: false, conflictAction: 'uniquify',
      })
      asset.downloadId = downloadId
      await chrome.storage.local.set({ [key]: { ...asset, state: 'saving' } })
      const result = await waitForDownload(downloadId)
      await chrome.storage.local.set({ [key]: { ...asset, state: 'saved', path: result.filename } })
    } catch (error) {
      await chrome.storage.local.set({ [key]: { ...asset, state: 'failed', error: error.message } })
      throw new Error('图片保存在笔记中，文件保存失败，请点击图片下方重试。')
    }
  })().finally(() => imageJobs.delete(id))
  imageJobs.set(id, job)
  return job
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    let finished = false
    async function check() {
      try {
        const [item] = await chrome.downloads.search({ id })
        if (finished) return
        if (item?.state === 'complete') finish(null, item)
        else if (!item || item.state === 'interrupted') finish(new Error(item?.error || '下载失败'))
      } catch (error) { finish(error) }
    }
    function changed(delta) { if (delta.id === id) void check() }
    function finish(error, item) {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      chrome.downloads.onChanged.removeListener(changed)
      if (error) reject(error)
      else resolve(item)
    }
    const timeout = setTimeout(() => finish(new Error('保存超时')), 25000)
    chrome.downloads.onChanged.addListener(changed)
    void check()
  })
}

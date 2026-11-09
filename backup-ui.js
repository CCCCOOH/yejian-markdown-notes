import { request } from './notes.js'

export function initializeBackup(getNotes, getEditor, announce) {
  const $ = id => document.getElementById(id)
  const dialog = $('github-dialog')
  let tokenSaved = false
  async function openSettings() {
    const { githubConfig, githubLastBackup } = await chrome.storage.local.get(['githubConfig', 'githubLastBackup'])
    const config = githubConfig || {}
    $('github-repo').value = config.repo || ''
    $('github-branch').value = config.branch || ''
    $('github-folder').value = config.folder || 'yejian'
    $('github-token').value = ''
    tokenSaved = !!config.token
    $('github-token').placeholder = tokenSaved ? '已保存，留空保持不变' : 'Fine-grained personal access token'
    $('github-error').textContent = ''
    $('github-last').textContent = githubLastBackup ? `上次备份：${new Date(githubLastBackup.at).toLocaleString()} · ${githubLastBackup.count} 条笔记` : ''
    dialog.showModal()
    $('github-repo').focus({ preventScroll: true })
  }
  $('github-settings').addEventListener('click', openSettings)
  $('github-cancel').addEventListener('click', () => dialog.close())
  $('github-form').addEventListener('submit', async event => {
    event.preventDefault()
    const button = $('github-save')
    button.disabled = true
    try {
      if (!await chrome.permissions.request({ origins: ['https://api.github.com/*'] })) throw new Error('未授权连接 GitHub，设置未保存。')
      await request('set-github-config', { config: {
        repo: $('github-repo').value, branch: $('github-branch').value,
        folder: $('github-folder').value, token: $('github-token').value,
      } })
      $('github-token').value = ''
      dialog.close()
      announce('GitHub 备份设置已保存')
    } catch (error) { $('github-error').textContent = error.message }
    finally { button.disabled = false }
  })
  dialog.addEventListener('close', () => { $('github-token').value = '' })
  $('github-disconnect').addEventListener('click', async () => {
    await chrome.storage.local.remove('githubConfig')
    $('github-token').value = ''
    tokenSaved = false
    $('github-token').placeholder = 'Fine-grained personal access token'
    announce('已清除 GitHub 连接信息')
  })
  $('backup-github').addEventListener('click', async () => {
    const button = $('backup-github')
    button.disabled = true
    button.classList.add('backing-up')
    try {
      if (!(await chrome.storage.local.get('githubConfig')).githubConfig) { await openSettings(); return }
      const notes = structuredClone(getNotes())
      const files = [], assets = new Map()
      for (const note of notes) {
        const doc = note.content || { type: 'doc', content: [{ type: 'paragraph' }] }
        const images = []
        function visit(node) {
          if (node.type === 'image' && node.attrs?.assetId) images.push(node)
          node.content?.forEach(visit)
        }
        visit(doc)
        for (const node of images) {
          const id = node.attrs.assetId
          const asset = (await chrome.storage.local.get('image:' + id))['image:' + id]
          const match = asset?.dataUrl?.match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/s)
          if (!match) throw new Error('笔记图片缺失，备份未上传。')
          const path = `images/${id}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`
          assets.set(path, { path, content: match[2], encoding: 'base64' })
          node.attrs.src = path
          node.attrs.assetId = null
        }
        const title = note.title?.trim() || '无标题笔记'
        const name = title.replace(/[<>:"/\\|?*\x00-\x1f.]/g, '_').slice(0, 70)
        files.push({ path: `${name}-${note.id}.md`, content: '# ' + title.replace(/\r?\n/g, ' ') + '\n\n' + getEditor().markdown.serialize(doc) + '\n' })
      }
      const result = await request('backup-github', { files: [...files, ...assets.values()] })
      announce(`已备份 ${result.count} 条笔记到 GitHub`)
    } catch (error) { announce(error.message) }
    finally { button.disabled = false; button.classList.remove('backing-up') }
  })
}

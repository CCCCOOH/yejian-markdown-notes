// Runs only in the extension service worker. Credentials never reach webpage scripts.
function validateGitHubConfig(input) {
  const repo = String(input.repo || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '')
  if (!/^[\w-]+\/[\w.-]+$/.test(repo) || repo.endsWith('/..') || repo.endsWith('/.')) throw new Error('请填写 GitHub 仓库地址或 用户名/仓库名。')
  const branch = String(input.branch || '').trim()
  if (branch && (!/^[\w./-]+$/.test(branch) || branch.includes('..') || branch.includes('//'))) throw new Error('分支名称无效。')
  const folder = validImageFolder(input.folder || 'yejian')
  const token = String(input.token || '').trim()
  if (!token || /\s/.test(token)) throw new Error('请填写有效的 GitHub 访问令牌。')
  return { repo, branch, folder, token }
}

let githubJob
function backupToGitHub(files) {
  if (githubJob) throw new Error('已有备份正在进行，请稍候。')
  githubJob = performGitHubBackup(files).finally(() => { githubJob = null })
  return githubJob
}

async function performGitHubBackup(files) {
  const config = validateGitHubConfig((await chrome.storage.local.get('githubConfig')).githubConfig || {})
  if (!Array.isArray(files) || !files.length) throw new Error('没有可备份的笔记。')
  if (!await chrome.permissions.contains({ origins: ['https://api.github.com/*'] })) throw new Error('请在 GitHub 备份设置中授权连接 GitHub。')
  const base = 'https://api.github.com/repos/' + config.repo
  async function api(path, method = 'GET', body) {
    let response
    try {
      response = await fetch(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { Authorization: 'Bearer ' + config.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch { throw new Error('无法连接 GitHub，请检查网络后重试。') }
    if (!response.ok) {
      const messages = { 401: 'GitHub 令牌无效或已过期。', 403: 'GitHub 拒绝访问，请检查令牌的 Contents 写入权限或请求额度。', 404: '仓库或分支不存在，或令牌没有访问权限。', 409: '仓库状态已变化，请重试备份。', 422: '分支更新被拒绝，请检查分支规则或稍后重试。' }
      throw new Error(messages[response.status] || `GitHub 备份失败（${response.status}）。`)
    }
    return response.json()
  }
  const repo = await api('')
  const branch = config.branch || repo.default_branch
  // Git trees require a first commit. Initialize only an actually empty repository.
  if (repo.size === 0) {
    const branches = await api('/branches?per_page=1')
    if (!branches.length) await api('/contents/.yejian-backup', 'PUT', {
      message: 'Initialize Yejian backups', content: btoa('Yejian Markdown backups\n'), branch,
    })
  }
  const refPath = '/git/refs/heads/' + branch.split('/').map(encodeURIComponent).join('/')
  const ref = await api(refPath.replace('/refs/', '/ref/'))
  const parent = await api('/git/commits/' + ref.object.sha)
  const snapshot = config.folder + '/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8)
  const tree = []
  for (const file of files) {
    if (!file || typeof file.content !== 'string' || !/^(?:images\/)?[^/\\]+\.(md|png|jpg|webp|gif)$/.test(file.path) || file.path.includes('..')) throw new Error('备份文件无效。')
    const entry = { path: snapshot + '/' + file.path, mode: '100644', type: 'blob' }
    if (file.encoding === 'base64') {
      const blob = await api('/git/blobs', 'POST', { content: file.content, encoding: 'base64' })
      entry.sha = blob.sha
    } else entry.content = file.content
    tree.push(entry)
  }
  const created = await api('/git/trees', 'POST', { base_tree: parent.tree.sha, tree })
  const commit = await api('/git/commits', 'POST', { message: 'Back up Yejian notes', tree: created.sha, parents: [ref.object.sha] })
  // A concurrent remote update fails safely instead of overwriting it.
  await api(refPath, 'PATCH', { sha: commit.sha, force: false })
  const result = { at: Date.now(), count: files.filter(file => file.path.endsWith('.md')).length, url: `https://github.com/${config.repo}/tree/${commit.sha}/${snapshot.split('/').map(encodeURIComponent).join('/')}` }
  await chrome.storage.local.set({ githubLastBackup: result })
  return result
}

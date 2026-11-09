const systemTheme = matchMedia('(prefers-color-scheme: dark)')
const choices = ['system', 'light', 'dark']
let preference = 'system'

function applyTheme(value) {
  preference = choices.includes(value) ? value : 'system'
  document.documentElement.dataset.theme = preference
  const resolved = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference
  document.documentElement.style.colorScheme = resolved
  document.documentElement.dataset.resolvedTheme = resolved
  const toggle = document.getElementById('theme-toggle')
  const label = resolved === 'dark' ? '切换为浅色主题' : '切换为深色主题'
  toggle.setAttribute('aria-label', label)
  toggle.title = label
  const select = document.getElementById('theme-choice')
  if (select) select.value = preference
}

export async function initializeTheme() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) applyTheme(changes.theme.newValue)
  })
  applyTheme((await chrome.storage.local.get('theme')).theme)
  systemTheme.addEventListener('change', () => applyTheme(preference))
  async function saveTheme(next) {
    try {
      await chrome.storage.local.set({ theme: next })
      applyTheme(next)
    } catch {
      applyTheme(preference)
      document.getElementById('theme-error').hidden = false
      return
    }
    document.getElementById('theme-error').hidden = true
  }
  document.getElementById('theme-choice').addEventListener('change', event => saveTheme(event.target.value))
  document.getElementById('theme-toggle').addEventListener('click', () => {
    saveTheme(document.documentElement.dataset.resolvedTheme === 'dark' ? 'light' : 'dark')
  })
}

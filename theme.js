const systemTheme = matchMedia('(prefers-color-scheme: dark)')
const choices = ['system', 'light', 'dark']
let preference = 'system'

function applyTheme(value) {
  preference = choices.includes(value) ? value : 'system'
  document.documentElement.dataset.theme = preference
  document.documentElement.style.colorScheme = preference === 'system'
    ? (systemTheme.matches ? 'dark' : 'light') : preference
  const select = document.getElementById('theme-choice')
  if (select) select.value = preference
}

export async function initializeTheme() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) applyTheme(changes.theme.newValue)
  })
  applyTheme((await chrome.storage.local.get('theme')).theme)
  systemTheme.addEventListener('change', () => applyTheme(preference))
  document.getElementById('theme-choice').addEventListener('change', async event => {
    const next = event.target.value
    try {
      await chrome.storage.local.set({ theme: next })
      applyTheme(next)
    } catch {
      event.target.value = preference
      document.getElementById('theme-error').hidden = false
      return
    }
    document.getElementById('theme-error').hidden = true
  })
}

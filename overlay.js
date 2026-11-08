(() => {
  if (globalThis.__yejianOverlay) return
  globalThis.__yejianOverlay = true

  const panelURL = chrome.runtime.getURL('panel.html')
  const panelOrigin = panelURL.slice(0, panelURL.lastIndexOf('/'))
  const gap = 8
  let host
  let frame
  let bounds
  let gesture
  let timer
  let ready = false
  let visible = false
  let creating
  let ring
  let ringPosition
  const ringSize = 42

  function positionRing(snap = false) {
    if (!ring) return
    const maxX = Math.max(0, window.innerWidth - ringSize)
    const maxY = Math.max(0, window.innerHeight - ringSize)
    ringPosition.x = Math.max(0, Math.min(maxX, ringPosition.x))
    ringPosition.y = Math.max(0, Math.min(maxY, ringPosition.y))
    if (snap) {
      const edges = [
        ['left', ringPosition.x], ['right', maxX - ringPosition.x],
        ['top', ringPosition.y], ['bottom', maxY - ringPosition.y],
      ].sort((a, b) => a[1] - b[1])
      ringPosition.edge = edges[0][1] <= 24 ? edges[0][0] : null
    }
    if (ringPosition.edge === 'left') ringPosition.x = -ringSize / 2
    if (ringPosition.edge === 'right') ringPosition.x = window.innerWidth - ringSize / 2
    if (ringPosition.edge === 'top') ringPosition.y = -ringSize / 2
    if (ringPosition.edge === 'bottom') ringPosition.y = window.innerHeight - ringSize / 2
    ring.style.setProperty('left', ringPosition.x + 'px', 'important')
    ring.style.setProperty('top', ringPosition.y + 'px', 'important')
  }

  function ensureRing() {
    if (ring) return
    ring = document.createElement('div')
    ring.setAttribute('popover', 'manual')
    ring.style.cssText = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;width:42px!important;height:42px!important;background:transparent!important;overflow:visible!important;z-index:2147483647!important'
    const shadow = ring.attachShadow({ mode: 'closed' })
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', '展开页笺')
    button.title = '展开页笺'
    button.style.cssText = 'box-sizing:border-box;width:42px;height:42px;padding:0;border:6px solid white;border-radius:50%;background:transparent;box-shadow:0 0 0 1px #0002,inset 0 0 0 1px #0002,0 2px 8px #0003;cursor:grab;touch-action:none'
    let start
    let moved = false
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      event.preventDefault()
      start = { x: event.screenX, y: event.screenY, position: { ...ringPosition } }
      moved = false
      button.setPointerCapture(event.pointerId)
    })
    button.addEventListener('pointermove', event => {
      if (!start) return
      const dx = event.screenX - start.x
      const dy = event.screenY - start.y
      moved ||= Math.hypot(dx, dy) > 5
      if (!moved) return
      ringPosition = { x: start.position.x + dx, y: start.position.y + dy, edge: null }
      positionRing()
    })
    button.addEventListener('lostpointercapture', () => {
      start = null
      if (!moved) return
      positionRing(true)
      chrome.runtime.sendMessage({ type: 'store-ring', position: ringPosition }).catch(() => {})
    })
    button.addEventListener('click', event => {
      if (!moved || event.detail === 0) show()
    })
    shadow.append(button)
    document.documentElement.append(ring)
  }

  function hideRing() {
    if (!ring) return
    try { ring.hidePopover() } catch {}
    ring.style.setProperty('display', 'none', 'important')
  }

  function showRing() {
    ensureRing()
    ringPosition ??= { x: window.innerWidth - ringSize / 2, y: Math.max(0, bounds.y), edge: 'right' }
    ring.style.setProperty('display', 'block', 'important')
    try { ring.showPopover() } catch {}
    positionRing()
  }


  function constrain(rect) {
    const maxWidth = Math.max(1, window.innerWidth - 2 * gap)
    const maxHeight = Math.max(1, window.innerHeight - 2 * gap)
    const width = Math.min(maxWidth, Math.max(320, rect.width))
    const height = Math.min(maxHeight, Math.max(320, rect.height))
    return {
      x: Math.max(gap, Math.min(rect.x, window.innerWidth - width - gap)),
      y: Math.max(gap, Math.min(rect.y, window.innerHeight - height - gap)),
      width, height,
    }
  }

  function layout(rect) {
    bounds = constrain(rect)
    for (const [key, value] of Object.entries({
      left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height,
    })) {
      host.style.setProperty(key, value + 'px', 'important')
    }
  }

  function show() {
    if (!host) return
    hideRing()
    visible = true
    host.style.setProperty('display', 'block', 'important')
    try { host.showPopover?.() } catch {}
    layout(bounds)
  }

  function hide(minimize = true) {
    visible = false
    gesture = null
    try { host.hidePopover?.() } catch {}
    host.style.setProperty('display', 'none', 'important')
    if (minimize) showRing()
  }

  async function createPanel() {
    const result = await chrome.runtime.sendMessage({ type: 'prepare-panel' })
    if (!result?.ok) throw new Error('Could not prepare the panel')
    const { bounds: stored, ticket, ringPosition: storedRing } = result.data
    ringPosition ??= storedRing
    host?.remove()
    ready = false
    host = document.createElement('div')
    host.setAttribute('popover', 'manual')
    for (const [name, value] of Object.entries({
      all: 'initial',
      position: 'fixed',
      inset: 'auto',
      margin: '0',
      padding: '0',
      border: '0',
      'border-radius': '9px',
      'box-shadow': '0 18px 65px #24201935, 0 3px 12px #24201924',
      background: '#ffffff',
      overflow: 'hidden',
      'z-index': '2147483647',
      'color-scheme': 'light',
    })) host.style.setProperty(name, value, 'important')
    const shadow = host.attachShadow({ mode: 'closed' })
    frame = document.createElement('iframe')
    frame.title = '页笺 Markdown 笔记'
    frame.allow = 'clipboard-write'
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:#ffffff'
    frame.src = panelURL + '#' + ticket
    const resize = document.createElement('div')
    resize.style.cssText = 'position:absolute;right:0;bottom:0;width:24px;height:24px;cursor:nwse-resize;touch-action:none'
    let resizeStart
    resize.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      event.preventDefault()
      resizeStart = { x: event.screenX, y: event.screenY, bounds: { ...bounds } }
      resize.setPointerCapture(event.pointerId)
    })
    resize.addEventListener('pointermove', event => {
      if (!resizeStart) return
      const start = resizeStart.bounds
      layout({
        ...start,
        width: Math.min(window.innerWidth - start.x - gap, start.width + event.screenX - resizeStart.x),
        height: Math.min(window.innerHeight - start.y - gap, start.height + event.screenY - resizeStart.y),
      })
    })
    resize.addEventListener('lostpointercapture', () => {
      resizeStart = null
      chrome.runtime.sendMessage({ type: 'store-bounds', bounds }).catch(() => {})
    })
    shadow.append(frame, resize)
    document.documentElement.append(host)
    bounds = stored ?? { x: window.innerWidth - 816, y: 62, width: 790, height: 565 }
    show()
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (ready || !host) return
      const wasVisible = visible
      hide(false)
      hideRing()
      host.remove()
      host = null
      frame = null
      if (wasVisible) chrome.runtime.sendMessage({ type: 'open-standalone' }).catch(() => {})
    }, 4500)
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== 'toggle-panel') return
    if (host?.isConnected) {
      if (visible) hide()
      else show()
      respond({ ok: true })
      return
    }
    creating ??= createPanel().finally(() => { creating = null })
    creating.then(() => respond({ ok: true }), () => respond({ ok: false }))
    return true
  })

  window.addEventListener('resize', () => {
    if (host && visible) layout(bounds)
    if (ring && !visible) positionRing()
  })
  window.addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== panelOrigin) return
    const message = event.data
    if (message?.channel !== 'yejian-panel') return
    if (message.type === 'ready') {
      ready = true
      clearTimeout(timer)
      return
    }
    if (!visible) return
    if (message.type === 'close') {
      hide()
    } else if (message.type === 'drag-start' || message.type === 'resize-start') {
      gesture = { type: message.type, x: message.x, y: message.y, bounds: { ...bounds } }
    } else if (message.type === 'gesture-move' && gesture) {
      const dx = message.x - gesture.x
      const dy = message.y - gesture.y
      const start = gesture.bounds
      if (gesture.type === 'drag-start') {
        layout({ ...start, x: start.x + dx, y: start.y + dy })
      } else {
        layout({
          ...start,
          width: Math.min(window.innerWidth - start.x - gap, start.width + dx),
          height: Math.min(window.innerHeight - start.y - gap, start.height + dy),
        })
      }
    } else if (message.type === 'gesture-end' && gesture) {
      gesture = null
      chrome.runtime.sendMessage({ type: 'store-bounds', bounds }).catch(() => {})
    }
  })
})()

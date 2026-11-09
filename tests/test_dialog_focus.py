"""Run with Python and Playwright's Chromium installed."""
import json
import sys
import subprocess
import shutil
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

REPO = Path(__file__).resolve().parents[1]


def exercise_dialogs(page):
    expect(page.locator("#app")).to_be_visible()
    page.locator("#note-title").fill("Focus regression")
    expect(page.locator("#save-label")).to_have_text("已保存")
    page.locator("#delete-note").click()
    expect(page.locator("#delete-dialog")).to_be_visible()
    expect(page.locator('#delete-dialog button[value="cancel"]')).to_be_focused()
    page.locator('#delete-dialog button[value="cancel"]').click()

    page.locator('[data-action="link"]').click()
    expect(page.locator("#link-url")).to_be_focused()
    page.locator("#link-url").fill("https://example.com")
    page.locator("#link-text").fill("Example")
    page.locator('#link-form button[type="submit"]').click()
    expect(page.locator('.ProseMirror a[href="https://example.com/"]').last).to_have_text("Example")


def test_dialog_focus():
    with tempfile.TemporaryDirectory(prefix="yejian-focus-") as temp, sync_playwright() as p:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(REPO, extension, ignore=shutil.ignore_patterns(".git", "node_modules", "docs", "tests"))
        manifest_path = extension / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["host_permissions"] = ["http://example.test/*", "https://api.github.com/*"]
        manifest_path.write_text(json.dumps(manifest))
        context = p.chromium.launch_persistent_context(
            str(root / "profile"), channel="chromium", headless=True,
            args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}"],
        )
        try:
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
            warnings = []
            context.on("console", lambda msg: warnings.append(msg.text) if "autofocus" in msg.text.lower() else None)
            page = context.new_page()
            logs = context.new_cdp_session(page)
            logs.send("Log.enable")
            logs.on("Log.entryAdded", lambda event: warnings.append(event["entry"]["text"])
                    if "autofocus" in event["entry"]["text"].lower() else None)
            page.route("http://example.test/**", lambda route: route.fulfill(body="<h1>Host page</h1>", content_type="text/html"))
            page.goto("http://example.test")
            worker.evaluate("""async () => {
                const tabs = await chrome.tabs.query({});
                await toggle(tabs.find(tab => tab.url?.startsWith('http://example.test')));
            }""")
            page.wait_for_function("document.querySelector('[popover]') !== null")
            page.wait_for_timeout(500)
            frame = next(frame for frame in page.frames if frame.url.startswith("chrome-extension://"))
            expect(frame.locator("#app")).to_be_visible()
            print("Warnings after panel load:", warnings)
            # The original regression occurs during HTML parsing, before any dialog opens.
            assert not warnings, warnings
            # Check the actual embedding boundary before emulating media. Emulating
            # all frames hides a parent forcing the embedded document to light.
            expect(page.locator('[popover]')).to_have_css('color-scheme', 'light dark')
            # Theme defaults to system and follows live OS changes.
            page.emulate_media(color_scheme="dark")
            expect(frame.locator("#theme-choice")).to_have_value("system")
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(32, 33, 36)")
            frame.locator("#theme-toggle").click()
            expect(frame.locator("#theme-choice")).to_have_value("light")
            expect(frame.locator("#theme-toggle")).to_have_attribute("aria-label", "切换为深色主题")
            frame.locator("#more-menu summary").click()
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(255, 255, 255)")
            page.emulate_media(color_scheme="light")
            frame.locator("#theme-choice").select_option("dark")
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(32, 33, 36)")
            frame.locator("#more-menu summary").click()
            # The same input rule must work for ASCII and Chinese quote markers.
            for marker in [">", "》"]:
                frame.locator("#new-note").evaluate("element => element.click()")
                body = frame.locator('.ProseMirror')
                body.click()
                page.keyboard.insert_text(marker)
                page.keyboard.press('Space')
                page.keyboard.insert_text('引用测试')
                expect(body.locator('blockquote')).to_have_text('引用测试')
                page.keyboard.press('Enter')
                page.keyboard.press('Enter')
                page.keyboard.insert_text('正文测试')
                expect(body).to_contain_text('正文测试')
                expect(body.locator('blockquote')).not_to_contain_text('正文测试')
            # Actual pointer gestures against closed-shadow resize handles.
            host = page.locator('[popover]')
            for edge in ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']:
                box = host.bounding_box()
                inset = 7 if len(edge) == 2 else 2
                x = box['x'] + (inset if 'w' in edge else box['width'] - inset if 'e' in edge else box['width']/2)
                y = box['y'] + (inset if 'n' in edge else box['height'] - inset if 's' in edge else box['height']/2)
                dx = 18 if 'w' in edge else -18 if 'e' in edge else 0
                dy = 18 if 'n' in edge else -18 if 's' in edge else 0
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.move(x + dx, y + dy, steps=4)
                page.mouse.up()
                after = host.bounding_box()
                if dx: assert abs(after['width'] - box['width'] + 18) < 2, (edge, box, after)
                if dy: assert abs(after['height'] - box['height'] + 18) < 2, (edge, box, after)
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            # Unconfigured backup opens settings without uploading notes.
            frame.locator('#backup-github').click()
            expect(frame.locator('#github-dialog')).to_be_visible()
            if '--live' in sys.argv:
                token = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
                frame.locator('#github-repo').fill('CCCCOOH/yejian-backup-test')
                frame.locator('#github-folder').fill('browser-tests')
                frame.locator('#github-token').fill(token)
                frame.locator('#github-save').click()
                expect(frame.locator('#github-dialog')).not_to_be_visible()
                frame.locator('#backup-github').click()
                expect(frame.locator('#toast')).to_contain_text('条笔记到 GitHub', timeout=60000)
                result = worker.evaluate("async () => (await chrome.storage.local.get('githubLastBackup')).githubLastBackup")
                assert result['count'] >= 2, result
                print('PASS: real browser settings and one-click backup:', result['url'])
            else:
                frame.locator('#github-cancel').click()
            exercise_dialogs(frame)
            worker.evaluate("() => toggle({id: -1})")
            popup = context.wait_for_event("page") if len(context.pages) < 3 else context.pages[-1]
            popup.wait_for_load_state()
            # A newly opened window restores the saved choice.
            expect(popup.locator("#theme-choice")).to_have_value("dark")
            expect(popup.locator(".paper")).to_have_css("background-color", "rgb(32, 33, 36)")
            exercise_dialogs(popup)
            popup.locator("#more-menu summary").click()
            popup.locator("#theme-choice").select_option("system")
            expect(frame.locator("#theme-choice")).to_have_value("system")
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(255, 255, 255)")
            page.emulate_media(color_scheme="dark")
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(32, 33, 36)")
            # Copy the real editor contents and inspect the ClipboardItem payload.
            for image_count in [1, 2]:
                worker.evaluate("""async count => {
                    const id = '11111111-1111-4111-8111-111111111111';
                    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
                    await chrome.storage.local.set({['image:' + id]: {dataUrl, filename: 'test.png', state: 'saved'}});
                    await saveNote({id:crypto.randomUUID(),title:'Clipboard fixture ' + count,content:{type:'doc',content:[
                        {type:'paragraph',content:[{type:'text',text:'图文复制测试'}]},
                        ...Array.from({length:count},()=>({type:'image',attrs:{assetId:id,src:'',alt:'测试图片'}}))
                    ]}},0);
                }""", image_count)
                card = frame.locator('.note-card').filter(has_text='Clipboard fixture ' + str(image_count))
                card.evaluate('element => element.click()')
                expect(frame.locator('.ProseMirror img')).to_have_count(image_count)
                frame.evaluate("""() => {
                    window.clipboardPayload = null;
                    navigator.clipboard.write = async items => {
                        const item = items[0]; const payload = {};
                        for (const type of item.types) { const blob = await item.getType(type); payload[type] = type.startsWith('text/') ? await blob.text() : blob.size; }
                        window.clipboardPayload = payload;
                    };
                }""")
                frame.locator('#copy-note').click()
                frame.wait_for_function('() => window.clipboardPayload !== null')
                payload = frame.evaluate('clipboardPayload')
                assert payload['text/html'].count('data:image/png;base64,') == image_count
                assert '图文复制测试' in payload['text/html']
                assert 'file://' not in payload['text/html']
                assert ('image/png' in payload) == (image_count == 1)
            assert not warnings, warnings
            print("PASS: themes, Chinese quotes, eight resize directions, GitHub settings, rich clipboard, and dialog focus")
        finally:
            context.close()


if __name__ == "__main__":
    test_dialog_focus()

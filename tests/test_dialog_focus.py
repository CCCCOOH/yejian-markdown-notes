"""Run with Python and Playwright's Chromium installed."""
import json
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
    expect(page.locator('.ProseMirror a[href="https://example.com/"]')).to_have_text("Example")


def test_dialog_focus():
    with tempfile.TemporaryDirectory(prefix="yejian-focus-") as temp, sync_playwright() as p:
        root = Path(temp)
        extension = root / "extension"
        shutil.copytree(REPO, extension, ignore=shutil.ignore_patterns(".git", "node_modules", "docs", "tests"))
        manifest_path = extension / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["host_permissions"] = ["http://example.test/*"]
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
            # Theme defaults to system and follows live OS changes.
            page.emulate_media(color_scheme="dark")
            expect(frame.locator("#theme-choice")).to_have_value("system")
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(32, 33, 36)")
            frame.locator("#more-menu summary").click()
            frame.locator("#theme-choice").select_option("light")
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(255, 255, 255)")
            page.emulate_media(color_scheme="light")
            frame.locator("#theme-choice").select_option("dark")
            expect(frame.locator(".paper")).to_have_css("background-color", "rgb(32, 33, 36)")
            frame.locator("#more-menu summary").click()
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
            assert not warnings, warnings
            print("PASS: no autofocus warnings; delete and link dialog focus works in iframe and standalone window")
        finally:
            context.close()


if __name__ == "__main__":
    test_dialog_focus()

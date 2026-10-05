"""Render og.png, favicon PNGs and the email screenshots. Usage: python3 dev/render_assets.py <base_url>"""
import sys, os
from playwright.sync_api import sync_playwright
base=sys.argv[1].rstrip('/')+'/'
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with sync_playwright() as p:
    b=p.chromium.launch()
    pg=b.new_page(viewport={'width':1200,'height':630})
    pg.goto(base+'dev/og.html'); pg.wait_for_timeout(800)
    pg.screenshot(path=os.path.join(ROOT,'og.png'))
    for size,name in [(32,'favicon-32.png'),(180,'apple-touch-icon.png')]:
        f=b.new_page(viewport={'width':size,'height':size})
        f.set_content(f'<html><body style="margin:0"><img src="{base}favicon.svg" style="width:{size}px;height:{size}px;display:block"></body></html>'); f.wait_for_timeout(300)
        f.screenshot(path=os.path.join(ROOT,name),omit_background=True)
    s=b.new_page(viewport={'width':1200,'height':900},device_scale_factor=1)
    s.goto(base); s.wait_for_timeout(1000)
    s.screenshot(path=os.path.join(ROOT,'shots','landing.png'),full_page=True)
    s.screenshot(path=os.path.join(ROOT,'shots','landing-fold.png'))
    s.click('text=Try it with sample data'); s.wait_for_timeout(800)
    s.screenshot(path=os.path.join(ROOT,'shots','report-sample.png'),full_page=True)
    s.screenshot(path=os.path.join(ROOT,'shots','report-sample-fold.png'))
    b.close()
print('ok')

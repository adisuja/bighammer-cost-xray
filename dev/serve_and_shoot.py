"""Local or live screenshot harness. Usage: python3 dev/serve_and_shoot.py <base_url> <outdir>"""
import sys, os, asyncio
from playwright.sync_api import sync_playwright
base=sys.argv[1].rstrip('/')+'/'; out=sys.argv[2]; os.makedirs(out,exist_ok=True)
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch()
    # landing desktop
    ctx=b.new_context(viewport={'width':1440,'height':900},device_scale_factor=1)
    pg=ctx.new_page(); pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None); pg.on('pageerror',lambda e: errs.append(str(e)))
    reqs=[]; pg.on('request',lambda r: reqs.append(r.url))
    pg.goto(base); pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{out}/landing-1440.png',full_page=True)
    n0=len(reqs)
    pg.click('text=Try it with sample data'); pg.wait_for_timeout(800)
    pg.screenshot(path=f'{out}/report-1440.png',full_page=True)
    print('requests after load:',reqs[n0:])
    pg.pdf(path=f'{out}/report.pdf',format='A4',print_background=True)
    # file upload of test csvs
    pg2=ctx.new_page(); pg2.on('pageerror',lambda e: errs.append(str(e)))
    pg2.goto(base); pg2.wait_for_timeout(600)
    td=os.path.join(ROOT,'test-data')
    pg2.set_input_files('#fileInput',[os.path.join(td,f) for f in sorted(os.listdir(td)) if f.endswith('.csv')])
    pg2.wait_for_timeout(1200)
    print('upload report visible:', pg2.is_visible('#report'), '| title:', pg2.title())
    print(pg2.inner_text('.kpis')[:600])
    pg2.screenshot(path=f'{out}/report-upload-1440.png',full_page=True)
    # bad file
    pg3=ctx.new_page(); pg3.goto(base); pg3.wait_for_timeout(400)
    pg3.set_input_files('#fileInput',files=[{'name':'bad.csv','mimeType':'text/csv','buffer':b'job_id,job_name,runs\n1,a,2\n'},{'name':'junk.csv','mimeType':'text/csv','buffer':b'foo,bar\n1,2\n'}])
    pg3.wait_for_timeout(800); print('errors shown:', pg3.inner_text('#msgs'))
    # mobile
    m=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
    mp=m.new_page(); mp.goto(base); mp.wait_for_timeout(900)
    mp.screenshot(path=f'{out}/landing-390.png',full_page=True)
    mp.click('text=Try it with sample data'); mp.wait_for_timeout(800)
    mp.screenshot(path=f'{out}/report-390.png',full_page=True)
    sw=mp.evaluate('document.documentElement.scrollWidth'); print('mobile scrollWidth', sw)
    b.close()
print('JS errors:', errs)

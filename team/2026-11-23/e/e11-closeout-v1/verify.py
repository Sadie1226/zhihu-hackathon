"""Read-only verification. Requires Pillow. Run: python verify.py"""
from pathlib import Path
import hashlib,json,re
from PIL import Image
p=Path(__file__).resolve().parent
rows=json.loads((p/'records/sample-map.json').read_text())['samples']
for r in rows:
 f=p/r['file'];assert hashlib.sha256(f.read_bytes()).hexdigest()==r['sha256'],f
 im=Image.open(f);assert list(im.size)==r['size'],f
 if r['kind']=='Gift':
  assert im.mode=='RGBA';a=im.getchannel('A');assert set(a.getdata())=={0,255}
  assert all(a.getpixel((x,y))==0 for x,y in [(x,0) for x in range(64)]+[(x,63) for x in range(64)]+[(0,y) for y in range(64)]+[(63,y) for y in range(64)])
 if r['id']=='M01' or r['kind']=='Scene':
  assert len(im.getcolors(im.width*im.height))<=96
  block=4 if r['id']=='M01' else 2
  for y in range(0,im.height,block):
   for x in range(0,im.width,block):assert len(set(im.crop((x,y,x+block,y+block)).getdata()))==1,(f,x,y)
for md in p.rglob('*.md'):
 for link in re.findall(r'\]\(([^)]+)\)',md.read_text()):
  if not link.startswith(('http:','https:','#')):assert (md.parent/link).exists(),(md,link)
w=json.loads((p/'sources/wardrobe.json').read_text());assert len(w['items'])==24 and len(w['expressions'])==9
for id in ('S02-leaf-cape','F01-neutral'):
 item=next(i for i in w['items']+w['expressions'] if i['id']==id)
 assert hashlib.sha256((p/'sources'/Path(item['layer']).name).read_bytes()).hexdigest()==item['sha256']
assert len(json.loads((p/'records/scene-inventory-14.json').read_text())['scenes'])==14
print('PASS: 5 sample hashes/sizes, Gift alpha+edges, Moment4px/Scene2px grids+96 colors, local Markdown links, r2 selected-layer hashes, 14-scene inventory.')

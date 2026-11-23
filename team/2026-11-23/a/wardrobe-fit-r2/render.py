"""Standalone adopted T/S/P/F renderer. No naked choices or multi-P slots."""
from pathlib import Path
from PIL import Image
import argparse,json,itertools,hashlib
ROOT=Path(__file__).resolve().parent
SPEC=json.loads((ROOT/'wardrobe.json').read_text(encoding='utf-8'))
ITEMS={r['id']:r for r in SPEC['items']+SPEC['expressions']}
def validate(value):
 if not isinstance(value,dict) or set(value)!={'outfit','cloth','accessory','face'}:raise ValueError('Expected outfit/cloth/accessory/face')
 for key,prefix in [('outfit','T'),('cloth','S'),('accessory','P'),('face','F')]:
  v=value[key]
  if v is None and key!='face':continue
  if not isinstance(v,str) or v not in ITEMS or not v.startswith(prefix):raise ValueError('Unknown or wrong-category '+key)
 if (value['outfit'] is None)==(value['cloth'] is None):raise ValueError('Exactly one T or S required')
 if value['outfit'] and value['accessory']:raise ValueError('T and P are mutually exclusive')
 return value
def layers_for(value):
 validate(value)
 acc=ITEMS.get(value['accessory']);face=ITEMS[value['face']];clothing=ITEMS[value['outfit'] or value['cloth']]
 # F01 is the approved original neutral identity, without redundant eye blending.
 faceLayer=None if value['face']=='F01-neutral' else face['layer']
 base=SPEC['base'] if faceLayer is None else SPEC['expressionBase']
 return [p for p in [acc['layer'] if acc and acc['renderPosition']=='behind-body' else None,base,faceLayer,clothing['layer'],acc['layer'] if acc and acc['renderPosition']!='behind-body' else None] if p]
def render(value):
 canvas=Image.new('RGBA',tuple(SPEC['canvas']))
 for filename in layers_for(value):
  with Image.open(ROOT/filename) as layer:canvas=Image.alpha_composite(canvas,layer.convert('RGBA'))
 return canvas
def verify():
 for row in ITEMS.values():
  data=(ROOT/row['layer']).read_bytes();assert hashlib.sha256(data).hexdigest()==row['sha256']
  with Image.open(ROOT/row['layer']) as im:assert im.mode=='RGBA' and im.size==(1024,1024)
 t=[k for k in ITEMS if k.startswith('T')];s=[k for k in ITEMS if k.startswith('S')];p=[None]+[k for k in ITEMS if k.startswith('P')];f=[k for k in ITEMS if k.startswith('F')]
 count=0
 for T,F in itertools.product(t,f):validate(dict(outfit=T,cloth=None,accessory=None,face=F));count+=1
 for S,P,F in itertools.product(s,p,f):validate(dict(outfit=None,cloth=S,accessory=P,face=F));count+=1
 good=dict(SPEC['modeRules']['default'])
 bad=[{**good,'cloth':None},{**good,'outfit':t[0]},{'outfit':t[0],'cloth':None,'accessory':p[1],'face':f[0]},{**good,'accessory':[p[1],p[2]]},{**good,'face':'F09-dark'},{**good,'cloth':[s[0],s[1]]},{**good,'face':[f[0],f[1]]},{**good,'accessory':'P99-unknown'}]
 for item in bad:
  try:validate(item)
  except ValueError:pass
  else:raise AssertionError(item)
 assert len(ITEMS)==33
 print(f'PASS: 33 layer hashes/specs; {count} legal T/S/P/F selections; {len(bad)} invalid selections rejected. Enumeration verifies selection rules, not visual approval of every combination.')
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--verify',action='store_true');parser.add_argument('--assembly');parser.add_argument('--output',type=Path);args=parser.parse_args()
 if args.verify:verify()
 if args.output:render(json.loads(args.assembly)).save(args.output)

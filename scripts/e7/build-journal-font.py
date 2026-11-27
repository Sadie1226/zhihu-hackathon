"""Optional offline rebuild of E7's extended pixel font.
Requires Python Pillow, fonttools[woff], and Windows SimSun at the path below.
Preserves all existing outlines and metrics; extends source-supported CJK/punctuation.
Run from any directory; generation can take several minutes. Not a runtime dependency.
"""
from pathlib import Path
import json,hashlib
from PIL import Image,ImageDraw,ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen
root=Path(__file__).resolve().parents[2]
f=TTFont(root/'public/assets/a5-v25/kanshan-pixel-v18.ttf')
cmap=f.getBestCmap();original_count=len(cmap);source=TTFont('C:/Windows/Fonts/simsun.ttc',fontNumber=0).getBestCmap()
wanted=set(cmap)|{c for c in source if 0x3400<=c<=0x9fff or 0x3000<=c<=0x303f or 0xff00<=c<=0xffef or 32<=c<=255 or 0x2000<=c<=0x206f}
missing=sorted(wanted-set(cmap));raster=ImageFont.truetype('C:/Windows/Fonts/simsun.ttc',16)
for code in missing:
 ch=chr(code);name=f'u{code:04X}';pen=TTGlyphPen(None);mask=Image.new('L',(24,24));ImageDraw.Draw(mask).text((0,0),ch,font=raster,fill=255)
 width=16 if code>255 else max(5,round(raster.getlength(ch)))
 for y in range(22):
  for x in range(width):
   if mask.getpixel((x,y))>=100:
    l=x*64;b=(16-y)*64;pen.moveTo((l,b));pen.lineTo((l+64,b));pen.lineTo((l+64,b+64));pen.lineTo((l,b+64));pen.closePath()
 f['glyf'][name]=pen.glyph();f['hmtx'][name]=(width*64,0)
 for table in f['cmap'].tables:
  if table.isUnicode():table.cmap[code]=name
f.setGlyphOrder(list(f['glyf'].glyphs));f.flavor='woff2';dest=root/'public/assets/a5-v25/kanshan-journal-complete-v1.woff2';f.save(dest)
audit={'originalGlyphs':original_count,'addedGlyphs':len(missing),'total':len(wanted),'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'source':'Same SimSun 16px raster as existing font; original outlines, advances and vertical metrics preserved. Extends source-supported CJK U+3400–U+9FFF and punctuation/Latin. Not all Unicode.','missingReportedTitle':[ch for ch in '修鞋摊旁边的搪瓷缸' if ord(ch) not in wanted]}
Path(__file__).with_name('journal-font-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(audit,ensure_ascii=True))


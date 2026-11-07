import glob, sys, os
from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.merge import Merger
src = sys.argv[1]; out = sys.argv[2]
# Character set: ASCII, CJK punctuation, full-width forms, GB2312 level-1 hanzi (3755 most common)
chars = set(range(0x20, 0x7f)) | set(range(0x3000, 0x3040)) | set(range(0xff00, 0xff70)) | {0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x00b7, 0x2192, 0x2190, 0x2713, 0x2715, 0x00d7}
for hi in range(0xb0, 0xd8):
    for lo in range(0xa1, 0xff):
        try: chars.add(ord(bytes([hi, lo]).decode('gb2312')))
        except UnicodeDecodeError: pass
print('target chars', len(chars))
parts = []
for f in sorted(glob.glob(os.path.join(src, 'lxgwwenkailite-regular-subset-*.woff2'))):
    font = TTFont(f)
    cmap = set(font.getBestCmap())
    keep = cmap & chars
    if not keep: continue
    opts = subset.Options(); opts.flavor = None; opts.layout_features = ['*']; opts.notdef_outline = True; opts.name_IDs = ['*']
    s = subset.Subsetter(opts); s.populate(unicodes=keep); s.subset(font)
    p = f'/tmp/part-{os.path.basename(f)}.ttf' if False else os.path.join(os.path.dirname(out), 'parts', os.path.basename(f) + '.ttf')
    os.makedirs(os.path.dirname(p), exist_ok=True); font.flavor = None; font.save(p); parts.append(p)
print('slices used', len(parts))
merged = Merger().merge(parts)
merged.flavor = 'woff2'
merged.save(out)
print('size', os.path.getsize(out))

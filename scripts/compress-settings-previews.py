# 设置页预览图压缩：design/settings-previews-src/*.jpg（原图）→ frontend/assets/settings/*.webp（上线用）
# 预览框固定为字号示意图的比例 760×412（见 css/screens.css .settings-preview-stage），
# 这里按同一比例居中裁切（与 object-fit: cover 显示的范围一致），宽度不超过 760（约 2 倍屏），再转 WebP。
# 高德 / OSM 对比图各占预览框一半宽，按半格比例裁切、缩到 380 宽。
# 依赖：Pillow、cwebp（brew install webp）。用法：python3 scripts/compress-settings-previews.py
import os, subprocess, tempfile
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'design/settings-previews-src')
OUT = os.path.join(ROOT, 'frontend/assets/settings')
RATIO = 760 / 412
COMPARE = {'osm-sample', 'amap-sample'}

def crop_to(im, ratio):
    w, h = im.size
    if w / h > ratio:
        nw = round(h * ratio); x = (w - nw) // 2
        return im.crop((x, 0, x + nw, h))
    nh = round(w / ratio); y = (h - nh) // 2
    return im.crop((0, y, w, y + nh))

os.makedirs(OUT, exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    for file in sorted(os.listdir(SRC)):
        name, ext = os.path.splitext(file)
        if ext.lower() not in ('.jpg', '.jpeg', '.png'):
            continue
        im = Image.open(os.path.join(SRC, file)).convert('RGB')
        if name in COMPARE:
            im = crop_to(im, 179 / 195).resize((380, 414), Image.LANCZOS)
        else:
            im = crop_to(im, RATIO)
            if im.size[0] > 760:
                im = im.resize((760, round(760 / RATIO)), Image.LANCZOS)
        png = os.path.join(tmp, name + '.png')
        im.save(png)
        quality = '70' if name.startswith('font') else '74'  # 字号图文字多，质量略高
        out = os.path.join(OUT, name + '.webp')
        subprocess.run(['cwebp', '-quiet', '-q', quality, '-m', '6', '-sharp_yuv', png, '-o', out], check=True)
        print(f'{name}: {os.path.getsize(os.path.join(SRC, file))} → {os.path.getsize(out)} 字节')

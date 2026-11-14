#!/usr/bin/env python3
"""
palette_lock.py —— 把任意来源的图强行拉进一个固定色板和固定像素网格。

用途：只对「场景背景板」使用。角色形象走拼装，不经过这里。

为什么需要它：不管模型画成什么样，出来都是一个色系、一种像素粒度。
这一步才是画风真正的锚，提示词只负责让图「大致对」。

三个子命令：

  1) 提色板（用你们已定的定稿去提，不要拍脑袋选颜色）
     python palette_lock.py extract --ref 定稿.png -n 16 -o palette.json

  2) 锁色板（单张或批量）
     python palette_lock.py lock --palette palette.json -g 96 in1.png in2.png -o out/

  3) 拼接对比图（自查用）
     python palette_lock.py compare --palette palette.json -g 96 in1.png in2.png -o cmp.png

-g/--grid 是最终的像素网格宽度（96 表示这张图被当成 96 像素宽的像素画）。
显示尺寸由 CSS 放大（image-rendering: pixelated），不要在这里放大。
"""
import argparse
import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow：pip install pillow --break-system-packages")


# ---------- 色板 ----------

def load_palette(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    colors = data["colors"] if isinstance(data, dict) else data
    out = []
    for c in colors:
        c = c.lstrip("#")
        out.append((int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)))
    return out


def save_palette(colors, path, meta=None):
    payload = {
        "colors": ["#%02X%02X%02X" % c for c in colors],
        "count": len(colors),
    }
    if meta:
        payload["source"] = meta
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    return payload


def _dedupe(colors, min_dist):
    """合并彼此过于接近的颜色。中位切分会把一整个渐变天空切成 8 个几乎一样的蓝，
    而樱花只剩 1 个粉色槽位——这一层就是来防这个的。
    保留顺序按出现权重（先拿到的通常覆盖面积大）。"""
    kept = []
    for c in colors:
        if all(_dist2(c, k) > min_dist * min_dist for k in kept):
            kept.append(c)
    return kept


def extract_palette(ref_path, n, merge=None):
    """从定稿里提色板。

    中位切分 + 相近色合并。合并阈值默认 12（约等于「肉眼要凑近才分得出」的
    距离），这一步是必要的：不合并的话，一张带渐变天空的定稿提 16 色，
    会出现 11 个蓝色、1 个粉色，量化后樱花糊成一片。
    """
    im = Image.open(ref_path).convert("RGB")
    im.thumbnail((256, 256), Image.LANCZOS)
    # 多提一些再合并，合并后仍能保住 n 色
    raw_n = min(n * 4, 256)
    q = im.quantize(colors=raw_n, method=Image.MEDIANCUT, dither=Image.NONE)
    flat = q.getpalette()
    # 图里的实际颜色数可能少于请求数（定稿本来就只有几十色），按实际取
    counts = q.getcolors(1 << 20) or []
    raw = [tuple(flat[i * 3 : i * 3 + 3]) for _, i in counts if i * 3 + 2 < len(flat)]
    # 按覆盖面积从大到小排，合并时面积大的先占位（天空蓝不会挤掉樱花的粉）
    raw.sort(key=lambda c: -sum(cnt for cnt, i in counts if tuple(flat[i*3:i*3+3]) == c))
    colors = _dedupe(raw, merge if merge is not None else 12)
    if len(colors) > n:
        colors = colors[:n]
    return colors


# ---------- 量化 ----------

def _dist2(a, b):
    # 带权重的 RGB 距离，接近人眼对绿色的敏感度
    dr = (a[0] - b[0]) * 0.30
    dg = (a[1] - b[1]) * 0.59
    db = (a[2] - b[2]) * 0.11
    return dr * dr + dg * dg + db * db


def nearest(color, palette):
    best, bestd = palette[0], float("inf")
    for p in palette:
        d = _dist2(color, p)
        if d < bestd:
            best, bestd = p, d
    return best


def quantize(im, palette, dither=False):
    """把图映射到固定色板。dither 打开会做 Floyd–Steinberg 抖动——
    像素画一般关掉（抖动在低分辨率下会变成噪点），只有做渐变天空时才值得开。"""
    im = im.convert("RGB")
    if not dither:
        return im.point(lambda v: v).convert("RGB") if False else Image.frombytes(
            "RGB", im.size,
            bytes(
                bytearray(
                    b
                    for px in im.getdata()
                    for b in nearest(px, palette)
                )
            ),
        )
    # 简易 Floyd–Steinberg
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            old = px[x, y]
            new = nearest(old, palette)
            px[x, y] = new
            err = tuple(old[i] - new[i] for i in range(3))
            for dx, dy, f in ((1, 0, 7 / 16), (-1, 1, 3 / 16), (0, 1, 5 / 16), (1, 1, 1 / 16)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    o = px[nx, ny]
                    px[nx, ny] = tuple(
                        max(0, min(255, int(o[i] + err[i] * f))) for i in range(3)
                    )
    return im


def hue_hist(im, bins=12):
    """色相直方图，只在饱和度够的像素上统计。

    为什么不用 RGB 距离：测过了，RGB 平均距离对这一类漂移几乎没反应。
    暖橙天空 (255,200,150) 到粉色 (242,182,204) 的距离只有 ~30，
    而到粉色确实是它最近的格子——RGB 距离「认为」它没问题，但它就是错的。
    色相可分开：橙色 ~30°、粉色 ~340°，差了整整 50°。
    """
    im = im.convert("HSV")
    im.thumbnail((128, 128), Image.BOX)
    hist = [0] * bins
    total = 0
    for h, s, v in im.getdata():
        if s < 40 or v < 30:      # 灰、黑、白不参与，它们没有色相
            continue
        hist[int(h * bins / 256)] += 1
        total += 1
    if total == 0:
        return [0.0] * bins
    return [c / total for c in hist]


def style_distance(a, b):
    """两张图色相分布的卡方距离。同一场景两次生成，这个值应该很小。"""
    return 0.5 * sum(
        (x - y) ** 2 / (x + y) for x, y in zip(a, b) if (x + y) > 0
    )


def drift_score(im, ref_hist):
    return style_distance(hue_hist(im), ref_hist)


def lock_one(path, palette, grid, dither=False, ref_hist=None):
    im = Image.open(path).convert("RGB")
    score = drift_score(im, ref_hist) if ref_hist is not None else 0.0
    w, h = im.size
    gh = max(1, round(h * grid / w))
    small = im.resize((grid, gh), Image.BOX)      # BOX 比 LANCZOS 更不容易振出杂色
    return quantize(small, palette, dither=dither), score


def cmd_lock(args):
    palette = load_palette(args.palette)
    ref_hist = hue_hist(Image.open(args.ref).convert("RGB")) if args.ref else None
    if ref_hist is None:
        print("⚠ 没给 --ref，跳过色相漂移检测（只锁色板，不判断画风对不对）")
    os.makedirs(args.out, exist_ok=True)
    rejected = []
    for p in args.inputs:
        out_im, score = lock_one(p, palette, args.grid, args.dither, ref_hist)
        base = os.path.splitext(os.path.basename(p))[0]
        if ref_hist is not None and score > args.max_drift:
            rejected.append((p, score))
            dst = os.path.join(args.out, base + f"@REJECTED-drift{score:.0f}.png")
            out_im.save(dst)
            print(f"[拒收] {os.path.basename(p)}  色相距离 {score:.3f} > {args.max_drift}")
            print(f"       -> {os.path.basename(dst)}（留档看，不进清单）")
            print("       按 e5 资产规范：漂移图不进清单，改模型/参考图重生成，不要手改颜色。")
            continue
        dst = os.path.join(args.out, base + f"@{args.grid}px.png")
        out_im.save(dst)
        tail = f"  色相距离 {score:.3f}" if ref_hist is not None else ""
        print(f"{os.path.basename(p)} -> {os.path.basename(dst)}  {out_im.size[0]}x{out_im.size[1]}{tail}")
    if rejected:
        sys.exit(f"\n{len(rejected)} 张色相漂移超阈值，已拒收。")


def cmd_extract(args):
    colors = extract_palette(args.ref, args.n)
    payload = save_palette(colors, args.out, meta=os.path.basename(args.ref))
    print(f"{args.out}  色板 {payload['count']} 色，来自 {os.path.basename(args.ref)}")
    print("  " + "  ".join(payload["colors"]))


def cmd_compare(args):
    palette = load_palette(args.palette)
    ref_hist = hue_hist(Image.open(args.ref).convert("RGB")) if args.ref else None
    ims = []
    for p in args.inputs:
        im, score = lock_one(p, palette, args.grid, args.dither, ref_hist)
        tail = f"  色相距离 {score:.3f}" if ref_hist is not None else ""
        print(f"{os.path.basename(p)}{tail}")
        ims.append(im)
    W = max(i.size[0] for i in ims)
    H = sum(i.size[1] for i in ims) + (len(ims) - 1) * 4
    canvas = Image.new("RGB", (W, H), (30, 30, 30))
    y = 0
    for i in ims:
        canvas.paste(i, (0, y))
        y += i.size[1] + 4
    # 最近邻放大到 2 倍方便肉眼看像素格（正式展示交给 CSS）
    canvas = canvas.resize((W * 2, H * 2), Image.NEAREST)
    canvas.save(args.out)
    print(f"{args.out}  {canvas.size[0]}x{canvas.size[1]}")


def main():
    ap = argparse.ArgumentParser(description="锁像素网格 + 锁色板")
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("extract", help="从定稿提色板")
    e.add_argument("--ref", required=True)
    e.add_argument("-n", type=int, default=16)
    e.add_argument("-o", "--out", default="palette.json")
    e.set_defaults(func=cmd_extract)

    l = sub.add_parser("lock", help="锁色板（批量）")
    l.add_argument("--palette", required=True)
    l.add_argument("-g", "--grid", type=int, default=96)
    l.add_argument("--dither", action="store_true")
    l.add_argument("--ref", required=True, help="定稿图，用它的色相分布做漂移基准")
    l.add_argument("--max-drift", type=float, default=0.06,
                   help="色相分布卡方距离的拒收阈值（默认 0.06）")
    l.add_argument("inputs", nargs="+")
    l.add_argument("-o", "--out", default="out")
    l.set_defaults(func=cmd_lock)

    c = sub.add_parser("compare", help="拼对比图")
    c.add_argument("--palette", required=True)
    c.add_argument("-g", "--grid", type=int, default=96)
    c.add_argument("--dither", action="store_true")
    c.add_argument("--ref", help="定稿图，给了才打印色相距离")
    c.add_argument("inputs", nargs="+")
    c.add_argument("-o", "--out", default="compare.png")
    c.set_defaults(func=cmd_compare)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

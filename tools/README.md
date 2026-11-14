# tools

美术与素材相关的脚本。归 **e** 管。

## palette_lock.py

把任意来源的图强行拉进固定色板和固定像素网格。**只对场景背景板使用**，角色形象走拼装，不经过这里。

为什么需要它：不管模型画成什么样，出来都是一个色系、一种像素粒度。这一步才是画风真正的锚，提示词只负责让图"大致对"。

```bash
# 1) 从定稿提取色板（不要拍脑袋选颜色）
python3 palette_lock.py extract --ref 定稿.png -n 16 -o palette.json

# 2) 锁色板，单张或批量
python3 palette_lock.py lock --palette palette.json -g 96 in1.png in2.png --ref 定稿.png -o out/

# 3) 拼对比图，自查用
python3 palette_lock.py compare --palette palette.json -g 96 in1.png in2.png -o cmp.png
```

`-g 96` 表示这张图被当成 96 像素宽的像素画。显示尺寸由 CSS 放大（`image-rendering: pixelated`），不要在这里放大。

需要 Pillow：`pip install pillow --break-system-packages`

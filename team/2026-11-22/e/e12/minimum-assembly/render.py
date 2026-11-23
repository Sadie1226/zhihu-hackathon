import json
from pathlib import Path
from PIL import Image

folder = Path(__file__).resolve().parent
spec = json.loads((folder / "assembly.json").read_text())
canvas = Image.new("RGBA", tuple(spec["canvas"]))
for layer in spec["layers"]:
    image = Image.open(folder / layer["file"]).convert("RGBA")
    canvas.alpha_composite(image, tuple(layer["offset"]))
expected = Image.open(folder / spec["expected"]).convert("RGBA")
for image in (canvas, expected):
    fully_clear = image.getchannel("A").point(lambda alpha: 255 if alpha == 0 else 0)
    image.paste((0, 0, 0, 0), mask=fully_clear)
assert canvas.tobytes() == expected.tobytes(), "Visible preview pixel mismatch"
canvas.save(folder / "rendered.png")
print("PASS: exact pixels against expected.png")

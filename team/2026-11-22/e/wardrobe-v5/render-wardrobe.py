"""Validate wardrobe selections and recompose transparent try-ons."""
import argparse
import itertools
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SPEC = json.loads((ROOT / "wardrobe.json").read_text(encoding="utf-8"))
RULES = SPEC["modeRules"]
ITEMS = {row["id"].split("-")[0]: row for row in SPEC["items"] + SPEC["expressions"]}
CANVAS = tuple(SPEC["canvas"])


def layers_for(codes):
    if len(codes) != len(set(codes)):
        raise ValueError("Repeated item ID")
    selected = [ITEMS[code] for code in codes]
    by_prefix = {prefix: [row for row in selected if row["id"].startswith(prefix)] for prefix in "TSPF"}
    slot_names = [row["slot"] for row in by_prefix["P"]]
    if any(len(by_prefix[prefix]) > 1 for prefix in "TSF"):
        raise ValueError("Choose at most one set, single garment, and expression")
    if by_prefix["T"] and (by_prefix["S"] or by_prefix["P"]):
        raise ValueError("A set is a complete look")
    if len(slot_names) != len(set(slot_names)):
        raise ValueError("Choose at most one accessory per slot")
    selected_ids = {row["id"] for row in selected}
    for rule in RULES["exclusiveCombinations"]:
        if rule["item"] in selected_ids and (rule.get("withItem") in selected_ids or rule.get("withSlot") in slot_names):
            raise ValueError(rule["reason"])
    accessory = {row["slot"]: row["layer"] for row in by_prefix["P"]}
    expression = by_prefix["F"]
    clothing = by_prefix["T"] or by_prefix["S"]
    return [
        layer for layer in (
            accessory.get("back"),
            SPEC["expressionBase"] if expression else SPEC["base"],
            expression[0]["layer"] if expression else None,
            clothing[0]["layer"] if clothing else None,
            accessory.get("carry"),
            accessory.get("eyes"),
            accessory.get("head"),
        ) if layer
    ]


def render(codes):
    canvas = Image.new("RGBA", CANVAS)
    for filename in layers_for(codes):
        with Image.open(ROOT / filename) as layer:
            canvas = Image.alpha_composite(canvas, layer.convert("RGBA"))
    return canvas


def visible_bytes(image):
    image = image.convert("RGBA")
    transparent = image.getchannel("A").point(lambda a: 255 if a == 0 else 0)
    image.paste((0, 0, 0, 0), mask=transparent)
    return image.tobytes()


def verify():
    for code, row in ITEMS.items():
        with Image.open(ROOT / row["layer"]) as layer:
            assert layer.mode == "RGBA" and layer.size == CANVAS, code
            assert layer.getchannel("A").getextrema() == (0, 255), code
            if "alphaBounds" in row:
                assert list(layer.getbbox()) == row["alphaBounds"], code
        with Image.open(ROOT / row["preview"]) as preview:
            assert visible_bytes(render([code])) == visible_bytes(preview), code
    for codes in (["T01", "S01"], ["T01", "P13"], ["P05", "P13"],
                  ["P12", "P15"], ["P22", "P23"], ["P23", "F09"],
                  ["T07", "F09"]):
        try:
            layers_for(codes)
        except ValueError:
            pass
        else:
            raise AssertionError(codes)
    options = [[None] + [c for c, r in ITEMS.items() if c.startswith("S")]]
    options.extend([None] + [c for c, r in ITEMS.items() if r.get("slot") == s] for s in RULES["accessorySlots"])
    combinations = 0
    for selected in itertools.product(*options):
        layers_for([c for c in selected if c])
        combinations += 1
    print(f"PASS: {len(ITEMS)} individual PNG previews; {combinations} mix selections; 7 invalid combinations rejected.")


def demo():
    choices = [
        ("Trail", ["S04", "P13", "P16", "P12"]),
        ("City walk", ["S06", "P13", "P23", "P15"]),
        ("Night camp", ["S07", "P22", "P12"]),
        ("Coast", ["S09", "P13", "P23", "P12"]),
        ("Cabin", ["S08", "P25", "P22"]),
        ("Forest", ["S02", "P05", "P15"]),
        ("Weekend", ["S05", "P05", "P19", "P22"]),
        ("Picnic", ["S03", "P05", "P22"]),
        ("Cloud trip", ["S01", "P19", "P16", "P12"]),
    ]
    font = ImageFont.truetype("DejaVuSans.ttf", 15)
    sheet = Image.new("RGB", (798, 855), "#ece8dc")
    draw = ImageDraw.Draw(sheet)
    for i, (name, codes) in enumerate(choices):
        out = render(codes)
        out.save(ROOT / "review" / f"wardrobe-mix-{i+1:02}-preview-1024w.png", optimize=True)
        tile = out.resize((250, 250), Image.Resampling.NEAREST)
        x, y = (i % 3) * 266 + 8, (i // 3) * 285 + 4
        draw.rectangle((x, y, x+249, y+249), fill="#bbc8cc")
        sheet.paste(tile, (x, y), tile)
        draw.text((x, y+255), name + "  " + " ".join(codes), font=font, fill="#20242c")
    sheet.save(ROOT / "review/mix-overview.png")


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("codes", nargs="*")
    cli.add_argument("--output", type=Path)
    cli.add_argument("--verify", action="store_true")
    cli.add_argument("--demo", action="store_true")
    args = cli.parse_args()
    if args.verify:
        verify()
    if args.demo:
        demo()
    if args.output:
        render(args.codes).save(args.output)

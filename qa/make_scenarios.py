"""Build the QA scenario set.

HR sources: Kodak PhotoCD set (24 images) + crops of the user's test images.
Degradations (x4), deterministic seeds:
  clean  : bicubic down x4 (antialiased)
  web    : down x4 + JPEG q60
  heavy  : blur s0.8 + down x4 + gaussian noise s6 + JPEG q40   (phone/messenger)
  soft   : blur s1.6 + down x4                                 (out-of-focus / old scan)
"""
import io
import os
import zlib
import urllib.request

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.abspath(__file__))
HR = os.path.join(ROOT, "data", "hr")
LR = os.path.join(ROOT, "data", "lr")
USER = os.environ.get("QA_USER_IMAGES", "")


def get_kodak():
    d = os.path.join(HR, "kodak")
    os.makedirs(d, exist_ok=True)
    for i in range(1, 25):
        p = os.path.join(d, f"kodim{i:02d}.png")
        if os.path.exists(p):
            continue
        url = f"https://r0k.us/graphics/kodak/kodak/kodim{i:02d}.png"
        req = urllib.request.Request(url, headers={"User-Agent": "qa-script"})
        data = urllib.request.urlopen(req, timeout=60).read()
        im = Image.open(io.BytesIO(data)).convert("RGB")
        im.save(p)


def user_crops():
    if not USER:
        return  # optional: set QA_USER_IMAGES to a folder with "Real World Image" and "Art Image"
    d = os.path.join(HR, "user")
    os.makedirs(d, exist_ok=True)
    real = Image.open(os.path.join(USER, "Real World Image", "1792425131738.jpg")).convert("RGB")
    # the phone JPEG is itself compressed: halve it first so the HR is clean
    real = real.resize((real.width // 2, real.height // 2), Image.LANCZOS)
    w, h = real.size
    boxes = [(w // 2 - 256, h // 2 - 256), (w // 4 - 256, h // 3 - 256), (3 * w // 4 - 256, 2 * h // 3 - 256)]
    for k, (x, y) in enumerate(boxes):
        real.crop((x, y, x + 512, y + 512)).save(os.path.join(d, f"real{k}.png"))
    art = Image.open(os.path.join(USER, "Art Image", "KazuScara.jpg")).convert("RGB")
    w, h = art.size
    for k, x in enumerate([0, (w - 512) // 2, w - 512]):
        art.crop((x, (h - 512) // 2, x + 512, (h - 512) // 2 + 512)).save(os.path.join(d, f"art{k}.png"))


def jpeg(im, q):
    b = io.BytesIO()
    im.save(b, "JPEG", quality=q)
    b.seek(0)
    return Image.open(b).convert("RGB")


def degrade(im, kind, seed):
    rng = np.random.default_rng(seed)
    w, h = im.size
    w4, h4 = w // 4 * 4, h // 4 * 4
    im = im.crop((0, 0, w4, h4))
    src = im
    if kind == "heavy":
        src = im.filter(ImageFilter.GaussianBlur(0.8))
    if kind == "soft":
        src = im.filter(ImageFilter.GaussianBlur(1.6))
    lr = src.resize((w4 // 4, h4 // 4), Image.BICUBIC, reducing_gap=None)
    if kind == "web":
        lr = jpeg(lr, 60)
    if kind == "heavy":
        a = np.asarray(lr).astype(np.float32) + rng.normal(0, 6, (lr.height, lr.width, 3))
        lr = Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8))
        lr = jpeg(lr, 40)
    return im, lr


def main():
    get_kodak()
    user_crops()
    kinds = ["clean", "web", "heavy", "soft"]
    for k in kinds:
        os.makedirs(os.path.join(LR, k), exist_ok=True)
    os.makedirs(os.path.join(HR, "gt"), exist_ok=True)
    n = 0
    for sub in ["kodak", "user"]:
        for f in sorted(os.listdir(os.path.join(HR, sub))):
            im = Image.open(os.path.join(HR, sub, f)).convert("RGB")
            name = os.path.splitext(f)[0]
            for i, k in enumerate(kinds):
                gt, lr = degrade(im, k, seed=zlib.crc32(f'{name}:{k}'.encode()))
                lr.save(os.path.join(LR, k, name + ".png"))
            gt.save(os.path.join(HR, "gt", name + ".png"))
            n += 1
    print(f"{n} images x {len(kinds)} scenarios")


if __name__ == "__main__":
    main()

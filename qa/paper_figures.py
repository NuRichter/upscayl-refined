"""Paper-style comparison on the real test images (x4).

Produces:
  docs/figures/fig_art.jpg, docs/figures/fig_real.jpg   (overview + zoomed patches)
  qa/results/paper_nriqa.csv                              (no-reference IQA)
  qa/results/paper_runtime.csv                            (seconds per method)

usage: python -I qa/paper_figures.py --art <art.jpg> --real <photo.jpg>
Faces in the real photo are not used as patches and are pixelated in the overview.
"""
import argparse
import csv
import json
import os
import shutil
import subprocess
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, "qa", "data", "paper")
FIG = os.path.join(ROOT, "docs", "figures")
RES = os.path.join(ROOT, "qa", "results")
CLI = os.path.join(ROOT, "export", "electron", "engine", "cli.js")
LEGACY_BIN = os.path.join(ROOT, "resources", "win", "bin", "upscayl-bin.exe")
LEGACY_MODELS = os.path.join(ROOT, "resources", "models")
EXTRA_MODELS = os.environ.get("QA_EXTRA_MODELS", "")

METHODS = [
    ("bicubic", "Bicubic", None),
    ("classic_standard", "Real-ESRGAN (Upscayl Standard)", ("classic", "upscayl-standard-4x")),
    ("classic_ultrasharp", "UltraSharp (Upscayl classic)", ("classic", "ultrasharp-4x")),
    ("usv2_dat2", "UltraSharp V2 (DAT2)", ("refined", "ultrasharp-v2-4x")),
    ("refined_nerve", "Refined NERVE 4x", ("refined", "refined-nerve-4x")),
    ("refined_auto", "Refined Auto (HEART)", ("refined", "refined-auto")),
]

# patch boxes in input pixels (x, y); 55 px patches are shown 1:1 at x4 (220 px).
PATCH = 55
ART_PATCHES = [(816, 184), (720, 360), (236, 380)]
# real photo: wave crest + rock, sign lettering, wristwatch, railing + twigs (no faces)
REAL_PATCHES = {"waves": (1985, 1585), "sign": (2440, 2738), "watch": (2010, 2478), "railing": (262, 1985)}
FACE_BOXES = [(930, 1580, 380, 440), (1290, 1770, 370, 500), (1560, 1850, 540, 580)]  # x, y, w, h
COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231"]


def font(size, bold=False):
    for name in (["timesbd.ttf"] if bold else []) + ["times.ttf", "DejaVuSerif.ttf"]:
        p = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def run_methods(inputs):
    """inputs: {name: path}. Returns {method: {name: out_path}}, runtime per method/name."""
    outs, times = {}, {}
    for key, _, how in METHODS:
        od = os.path.join(WORK, "out", key)
        os.makedirs(od, exist_ok=True)
        outs[key] = {}
        for name, src in inputs.items():
            dst = os.path.join(od, name + ".png")
            outs[key][name] = dst
            t0 = time.time()
            if os.environ.get("QA_REUSE") and os.path.exists(dst) and how is not None and how[0] == "classic":
                continue
            if how is None:
                im = Image.open(src).convert("RGB")
                im.resize((im.width * 4, im.height * 4), Image.BICUBIC).save(dst)
            elif how[0] == "classic":
                subprocess.run([LEGACY_BIN, "-i", src, "-o", dst, "-m", LEGACY_MODELS, "-n", how[1], "-s", "4", "-f", "png"],
                               capture_output=True, check=True)
            else:
                dirs = os.path.join(ROOT, "resources", "refined-models")
                if EXTRA_MODELS:
                    dirs += ";" + EXTRA_MODELS
                if os.path.exists(dst) and os.environ.get("QA_REUSE"):
                    continue
                # the engine prints its stats before exiting; a rare GPU-driver
                # hang at process teardown must not block the whole run
                proc = subprocess.Popen(["node", CLI, "-i", src, "-o", dst, "-m", how[1], "--models", dirs, "--quiet"],
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                line = proc.stdout.readline()
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                stats = json.loads(line)
                times[(key, name, "engine_ms")] = stats["totalMs"]
            times[(key, name)] = time.time() - t0
    return outs, times


def pixelate(im, boxes, scale=1.0):
    im = im.copy()
    for x, y, w, h in boxes:
        b = tuple(int(v * scale) for v in (x, y, x + w, y + h))
        region = im.crop(b)
        small = region.resize((max(1, region.width // 18), max(1, region.height // 18)), Image.BILINEAR)
        im.paste(small.resize(region.size, Image.NEAREST), b[:2])
    return im


def pixelate_faces(im):
    """Coarse pixelation of every detected face (OpenCV Haar, frontal + profile)
    plus the hand-checked boxes for this photo."""
    import cv2

    arr = np.asarray(im.convert("L"))
    small = cv2.resize(arr, (arr.shape[1] // 4, arr.shape[0] // 4))
    boxes = []
    for casc in ["haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"]:
        det = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, casc))
        for (x, y, w, h) in det.detectMultiScale(small, 1.08, 4, minSize=(30, 30)):
            boxes.append((x * 4, y * 4, w * 4, h * 4))
    boxes += FACE_BOXES
    out = im.copy()
    for x, y, w, h in boxes:
        m = int(0.35 * max(w, h))
        b = (max(0, x - m), max(0, y - m), min(im.width, x + w + m), min(im.height, y + h + m))
        region = out.crop(b)
        blk = max(1, region.width // 7)
        tiny = region.resize((max(1, region.width // blk), max(1, region.height // blk)), Image.BILINEAR)
        out.paste(tiny.resize(region.size, Image.NEAREST), b[:2])
    return out


def figure(rows, overview, title, out_path):
    """rows: list of (row_label, {method_key: patch_image}). overview: PIL image (already boxed)."""
    P = 220  # displayed patch size
    gap = 8
    cols = len(METHODS)
    label_h = 46
    ov_w = 360
    ov = overview.copy()
    ov.thumbnail((ov_w, 10_000), Image.LANCZOS)
    grid_w = cols * (P + gap)
    H = max(ov.height, len(rows) * (P + gap)) + label_h + 50
    W = ov_w + 16 + grid_w + 10
    fig = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(fig)
    fig.paste(ov, (6, 6))
    for r, (lab, patches) in enumerate(rows):
        y = 6 + r * (P + gap)
        for c, (key, _, _) in enumerate(METHODS):
            x = ov_w + 16 + c * (P + gap)
            fig.paste(patches[key] if patches[key].size == (P, P) else patches[key].resize((P, P), Image.LANCZOS), (x, y))
            d.rectangle([x, y, x + P - 1, y + P - 1], outline=COLORS[r % len(COLORS)], width=3)
    yl = 6 + len(rows) * (P + gap)
    f = font(17)
    for c, (_, name, _) in enumerate(METHODS):
        x = ov_w + 16 + c * (P + gap)
        txt = f"({chr(97 + c)}) {name}"
        lines = [txt] if d.textlength(txt, font=f) < P else [txt[: txt.find(" (", 4)] if txt.find(" (", 4) > 0 else txt, txt[txt.find(" (", 4):].strip() if txt.find(" (", 4) > 0 else ""]
        for k, line in enumerate(lines):
            d.text((x + (P - d.textlength(line, font=f)) / 2, yl + 4 + k * 19), line, fill="black", font=f)
    d.text((10, H - 34), title, fill="black", font=font(18))
    fig.save(out_path, quality=92, optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--art", required=True)
    ap.add_argument("--real", required=True)
    a = ap.parse_args()
    os.makedirs(os.path.join(WORK, "in"), exist_ok=True)
    os.makedirs(FIG, exist_ok=True)

    inputs = {"art": os.path.join(WORK, "in", "art.png")}
    Image.open(a.art).convert("RGB").save(inputs["art"])
    real = Image.open(a.real).convert("RGB")
    windows = {}
    for name, (px, py) in REAL_PATCHES.items():
        x = min(max(0, px + PATCH // 2 - 192), real.width - 384)
        y = min(max(0, py + PATCH // 2 - 192), real.height - 384)
        windows[name] = (x, y)
        p = os.path.join(WORK, "in", f"real_{name}.png")
        real.crop((x, y, x + 384, y + 384)).save(p)
        inputs[f"real_{name}"] = p

    outs, times = run_methods(inputs)

    # --- Fig. art ------------------------------------------------------------
    art_in = Image.open(inputs["art"])
    ov = art_in.copy()
    d = ImageDraw.Draw(ov)
    rows = []
    s = PATCH
    for i, (x, y) in enumerate(ART_PATCHES):
        d.rectangle([x - 6, y - 6, x + s + 6, y + s + 6], outline=COLORS[i], width=5)
        rows.append((f"P{i+1}", {k: Image.open(outs[k]["art"]).crop((x * 4, y * 4, (x + s) * 4, (y + s) * 4)) for k, _, _ in METHODS}))
    figure(rows, ov, "Fig. 1. x4 results on the painted-art test image (1200x672 input, processed whole). Artwork (c) its creator.",
           os.path.join(FIG, "fig_art.jpg"))

    # --- Fig. real -----------------------------------------------------------
    ov = pixelate_faces(real)
    d = ImageDraw.Draw(ov)
    rows = []
    s = PATCH
    for i, (name, (px, py)) in enumerate(REAL_PATCHES.items()):
        cx, cy = windows[name]
        ox, oy = px - cx, py - cy
        d.rectangle([px - 60, py - 60, px + s + 60, py + s + 60], outline=COLORS[i], width=22)
        rows.append((name, {k: Image.open(outs[k][f"real_{name}"]).crop((ox * 4, oy * 4, (ox + s) * 4, (oy + s) * 4)) for k, _, _ in METHODS}))
    figure(rows, ov, "Fig. 2. x4 results on the real-world phone photo (3024x4032, JPEG). Patches avoid faces; faces pixelated in the overview.",
           os.path.join(FIG, "fig_real.jpg"))

    # --- no-reference IQA --------------------------------------------------------
    import pyiqa
    import torch

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    metrics = {m: pyiqa.create_metric(m, device=dev) for m in ["musiq", "clipiqa", "maniqa", "niqe"]}
    rows = []
    for key, name, _ in METHODS:
        for img_name, p in outs[key].items():
            t = torch.from_numpy(np.asarray(Image.open(p).convert("RGB"))).permute(2, 0, 1)[None].float().div(255).to(dev)
            with torch.no_grad():
                vals = {m: float(fn(t)) for m, fn in metrics.items()}
            rows.append(dict(method=name, image=img_name, **vals))
    with open(os.path.join(RES, "paper_nriqa.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with open(os.path.join(RES, "paper_runtime.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["method", "image", "wall_s", "engine_ms"])
        for key, name, _ in METHODS:
            for img_name in inputs:
                w.writerow([name, img_name, round(times[(key, img_name)], 2), times.get((key, img_name, "engine_ms"), "")])
    print("done")


if __name__ == "__main__":
    main()

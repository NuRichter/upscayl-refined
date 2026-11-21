"""Score every output directory against the ground truth.

PSNR/SSIM on Y (BT.601, 4 px border crop) + LPIPS-alex on RGB (GPU).
Writes results.csv and prints a per-scenario table.
"""
import csv
import os
import sys

import numpy as np
import torch
import lpips
from PIL import Image
from skimage.metrics import structural_similarity

ROOT = os.path.dirname(os.path.abspath(__file__))
GT = os.path.join(ROOT, "data", "hr", "gt")
OUT = os.path.join(ROOT, "data", "out")
KINDS = ["clean", "web", "heavy", "soft"]
dev = "cuda" if torch.cuda.is_available() else "cpu"
loss = lpips.LPIPS(net="alex", verbose=False).to(dev).eval()


def y(a):
    a = a.astype(np.float64)
    return 16 + (65.481 * a[..., 0] + 128.553 * a[..., 1] + 24.966 * a[..., 2]) / 255


def score(gt, sr):
    b = 4
    g = gt[b:-b, b:-b]
    s = sr[b:-b, b:-b]
    gy, sy = y(g), y(s)
    mse = np.mean((gy - sy) ** 2)
    psnr = 99 if mse == 0 else 10 * np.log10(255.0**2 / mse)
    ssim = structural_similarity(gy, sy, data_range=255)
    t = lambda a: torch.from_numpy(a).permute(2, 0, 1)[None].float().div(127.5).sub(1).to(dev)
    with torch.no_grad():
        lp = float(loss(t(g), t(s)))
    return psnr, ssim, lp


def bicubic_dir():
    d = os.path.join(OUT, "bicubic")
    for k in KINDS:
        os.makedirs(os.path.join(d, k), exist_ok=True)
        for f in os.listdir(os.path.join(ROOT, "data", "lr", k)):
            p = os.path.join(d, k, f)
            if not os.path.exists(p):
                im = Image.open(os.path.join(ROOT, "lr", k, f)).convert("RGB")
                im.resize((im.width * 4, im.height * 4), Image.BICUBIC).save(p)


def main():
    bicubic_dir()
    methods = sorted(m for m in os.listdir(OUT) if os.path.isdir(os.path.join(OUT, m)))
    if len(sys.argv) > 1:
        methods = [m for m in methods if m in sys.argv[1:]]
    rows = []
    for m in methods:
        for k in KINDS:
            d = os.path.join(OUT, m, k)
            if not os.path.isdir(d):
                continue
            for f in sorted(os.listdir(d)):
                gp = os.path.join(GT, f)
                if not os.path.exists(gp):
                    continue
                gt = np.asarray(Image.open(gp).convert("RGB"))
                sr = Image.open(os.path.join(d, f)).convert("RGB")
                if sr.size != (gt.shape[1], gt.shape[0]):
                    sr = sr.resize((gt.shape[1], gt.shape[0]), Image.BICUBIC)
                p, s, l = score(gt, np.asarray(sr))
                grp = "art" if f.startswith("art") else "photo"
                rows.append(dict(method=m, kind=k, image=f, group=grp, psnr=p, ssim=s, lpips=l))
    with open(os.path.join(ROOT, "results", "results.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    # summary
    print(f"{'method':22s} " + " ".join(f"{k:>23s}" for k in KINDS) + f" {'avg LPIPS':>10s}")
    print(f"{'':22s} " + " ".join(f"{'PSNR  SSIM  LPIPS':>23s}" for _ in KINDS))
    summary = []
    for m in methods:
        cells, lps = [], []
        for k in KINDS:
            r = [x for x in rows if x["method"] == m and x["kind"] == k]
            if not r:
                cells.append(f"{'-':>23s}")
                continue
            P = np.mean([x["psnr"] for x in r]); S = np.mean([x["ssim"] for x in r]); L = np.mean([x["lpips"] for x in r])
            lps.append(L)
            cells.append(f"{P:7.2f} {S:6.4f} {L:7.4f}")
        summary.append((np.mean(lps) if lps else 9, m, cells))
    for avg, m, cells in sorted(summary):
        print(f"{m:22s} " + " ".join(cells) + f" {avg:10.4f}")


if __name__ == "__main__":
    main()

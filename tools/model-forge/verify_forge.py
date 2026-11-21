"""Numerical equivalence checks for forged graphs (ONNX Runtime CPU).

usage: python -I verify_forge.py <reference.onnx> <forged.onnx> <image> [--other b.onnx]
Reports PSNR (dB) between reference and forged outputs on a 96x96 crop.
  detail=0 must match reference; detail=1 must match --other;
  fidelity=[0,0] must match the plain network.
"""
import argparse
import json

import numpy as np
import onnxruntime as ort
from PIL import Image


def psnr(a, b):
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse == 0 else 10 * np.log10(1.0 / mse)


def run(path, x, extra=None):
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    feeds = {}
    for i in s.get_inputs():
        if i.name in (extra or {}):
            feeds[i.name] = extra[i.name]
        elif "float16" in i.type:
            feeds[i.name] = x.astype(np.float16)
        else:
            feeds[i.name] = x
    return s.run(None, feeds)[0].astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("forged")
    ap.add_argument("image")
    ap.add_argument("--other")
    a = ap.parse_args()

    im = Image.open(a.image).convert("RGB")
    w, h = im.size
    im = im.resize((w // 8, h // 8), Image.BICUBIC)
    arr = np.asarray(im, dtype=np.float32) / 255.0
    cy, cx = arr.shape[0] // 2, arr.shape[1] // 2
    crop = arr[cy - 48:cy + 48, cx - 48:cx + 48]
    x = np.ascontiguousarray(crop.transpose(2, 0, 1)[None])

    names = [i.name for i in ort.InferenceSession(a.forged, providers=["CPUExecutionProvider"]).get_inputs()]
    base = {}
    if "detail" in names:
        base["detail"] = np.array([0.0], np.float32)
    if "fidelity" in names:
        base["fidelity"] = np.array([0.0, 0.0], np.float32)
    ref = run(a.ref, x)
    out = {"psnr_vs_ref": round(psnr(np.clip(ref, 0, 1), np.clip(run(a.forged, x, base), 0, 1)), 2)}
    if a.other and "detail" in names:
        oth = run(a.other, x)
        e = dict(base, detail=np.array([1.0], np.float32))
        out["psnr_detail1_vs_other"] = round(psnr(np.clip(oth, 0, 1), np.clip(run(a.forged, x, e), 0, 1)), 2)
        e = dict(base, detail=np.array([0.5], np.float32))
        mid = np.clip(run(a.forged, x, e), 0, 1)
        out["psnr_detail05_vs_ref"] = round(psnr(np.clip(ref, 0, 1), mid), 2)
        out["psnr_detail05_vs_other"] = round(psnr(np.clip(oth, 0, 1), mid), 2)
    if "fidelity" in names:
        e = dict(base, fidelity=np.array([1.0, 0.0], np.float32))
        out["psnr_fid_chroma_vs_ref"] = round(psnr(np.clip(ref, 0, 1), run(a.forged, x, e)), 2)
        e = dict(base, fidelity=np.array([1.0, 1.0], np.float32))
        out["psnr_fid_full_vs_ref"] = round(psnr(np.clip(ref, 0, 1), run(a.forged, x, e)), 2)
    print(json.dumps(out))


if __name__ == "__main__":
    main()

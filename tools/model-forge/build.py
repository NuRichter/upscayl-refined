"""Download pinned upstream checkpoints and forge every Refined model.

usage: python -I tools/model-forge/build.py [--cache DIR] [--out resources/refined-models]

Needs: onnx, onnxruntime, onnxconverter-common, numpy (see requirements.txt).
Downloads are verified against recipes.json before anything is parsed.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url, dest, digest):
    if os.path.exists(dest) and sha256(dest) == digest:
        return dest
    tmp = dest + ".part"
    print(f"download {url}", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "upscayl-refined-forge"})
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    got = sha256(tmp)
    if got != digest:
        os.remove(tmp)
        raise SystemExit(f"checksum mismatch for {url}: {got}")
    os.replace(tmp, dest)
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(HERE, ".cache"))
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "resources", "refined-models"))
    ap.add_argument("--release", default=os.path.join(HERE, "release"),
                    help="where non-bundled models go (uploaded as release assets)")
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()
    recipes = json.load(open(os.path.join(HERE, "recipes.json"), encoding="utf8"))
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    paths = {}
    for key, s in recipes["sources"].items():
        paths[key] = fetch(s["url"], os.path.join(args.cache, key + ".onnx"), s["sha256"])

    man_path = os.path.join(args.out, "manifest.json")
    bundled = set()
    if os.path.exists(man_path):
        bundled = {e["id"] for e in json.load(open(man_path, encoding="utf8"))["models"] if e.get("bundled")}
    os.makedirs(args.release, exist_ok=True)

    results = {}
    for m in recipes["models"]:
        if args.only and m["id"] not in args.only:
            continue
        cmd = [sys.executable, "-I", os.path.join(HERE, "forge.py"), "--src", paths[m["src"]],
               "--out", args.out if m["id"] in bundled else args.release,
               "--name", os.path.splitext(m["file"])[0]]
        if m.get("blend"):
            cmd += ["--blend", paths[m["blend"]]]
        if m.get("fidelity"):
            cmd.append("--fidelity")
        if m.get("fp16"):
            cmd.append("--fp16")
        out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
        line = [l for l in out.splitlines() if l.startswith("{")][-1]
        rep = json.loads(line)
        results[m["id"]] = {"file": m["file"], "sha256": rep["sha256"], "bytes": rep["bytes"]}
        print(f"forged {m['id']}: {rep['bytes'] / 1e6:.1f} MB", flush=True)

    # refresh hashes/sizes in the manifest
    if os.path.exists(man_path):
        man = json.load(open(man_path, encoding="utf8"))
        for entry in man["models"]:
            r = results.get(entry["id"])
            if r and entry["file"] == r["file"]:
                entry["sha256"] = r["sha256"]
                entry["bytes"] = r["bytes"]
        with open(man_path, "w", encoding="utf8", newline="\n") as f:
            json.dump(man, f, indent=2)
            f.write("\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()

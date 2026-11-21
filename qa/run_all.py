"""Run every candidate configuration over the scenario set.

Refined configs go through the engine CLI in batch mode (one process per
config, sessions reused). Legacy configs use the installed upscayl-bin.
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "..")
CLI = os.path.join(SRC, "export", "electron", "engine", "cli.js")
MODELS = ";".join([os.path.join(SRC, "resources", "refined-models"), os.environ.get("QA_EXTRA_MODELS", os.path.join(ROOT, "data", "models"))])
LEGACY_BIN = r"C:\Program Files\Upscayl\resources\bin\upscayl-bin.exe"
LEGACY_MODELS = r"C:\Program Files\Upscayl\resources\models"
KINDS = ["clean", "web", "heavy", "soft"]

CONFIGS = {
    "pulse": dict(model="refined-pulse-4x", fidelity=[1, 0]),
    "nerve_d0": dict(model="refined-nerve-4x", detail=0.0, fidelity=[1, 0]),
    "nerve_d05": dict(model="refined-nerve-4x", detail=0.5, fidelity=[1, 0]),
    "nerve_d1": dict(model="refined-nerve-4x", detail=1.0, fidelity=[1, 0]),
    "nerve_d05_nofid": dict(model="refined-nerve-4x", detail=0.5, fidelity=[0, 0]),
    "heart_d0": dict(model="refined-heart-4x", detail=0.0, fidelity=[1, 0]),
    "heart_d025": dict(model="refined-heart-4x", detail=0.25, fidelity=[1, 0]),
    "heart_d05": dict(model="refined-heart-4x", detail=0.5, fidelity=[1, 0]),
    "heart_d075": dict(model="refined-heart-4x", detail=0.75, fidelity=[1, 0]),
    "heart_d1": dict(model="refined-heart-4x", detail=1.0, fidelity=[1, 0]),
    "heart_d05_nofid": dict(model="refined-heart-4x", detail=0.5, fidelity=[0, 0]),
    "heart_d05_fullfid": dict(model="refined-heart-4x", detail=0.5, fidelity=[1, 1]),
    "usv2_dat2": dict(model="ultrasharp-v2-4x"),
    "usv2_lite": dict(model="ultrasharp-v2-lite-4x"),
}
LEGACY = ["upscayl-standard-4x", "ultrasharp-4x", "high-fidelity-4x", "remacri-4x"]


def run_refined(name, cfg, only=None):
    jobs = []
    for k in KINDS:
        d = os.path.join(ROOT, "data", "lr", k)
        od = os.path.join(ROOT, "data", "out", name, k)
        os.makedirs(od, exist_ok=True)
        for f in sorted(os.listdir(d)):
            if only and f not in only:
                continue
            jobs.append(dict(input=os.path.join(d, f), output=os.path.join(od, f), scale=4, **cfg))
    jf = os.path.join(ROOT, "data", "out", f"jobs_{name}.json")
    json.dump(jobs, open(jf, "w"))
    t0 = time.time()
    r = subprocess.run(["node", CLI, "--batch", jf, "--models", MODELS], capture_output=True, text=True)
    lines = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")]
    errs = [l for l in lines if "error" in l]
    infer = sum(l.get("inferenceMs", 0) for l in lines)
    print(f"{name}: {len(lines)} jobs, {len(errs)} errors, infer {infer/1000:.1f}s, wall {time.time()-t0:.1f}s", flush=True)
    if errs:
        print("  first error:", errs[0]["error"][:300])
    json.dump(lines, open(os.path.join(ROOT, "data", "out", f"stats_{name}.json"), "w"))


def run_legacy(model):
    for k in KINDS:
        d = os.path.join(ROOT, "data", "lr", k)
        od = os.path.join(ROOT, "data", "out", "legacy_" + model, k)
        os.makedirs(od, exist_ok=True)
        t0 = time.time()
        subprocess.run([LEGACY_BIN, "-i", d, "-o", od, "-m", LEGACY_MODELS, "-n", model, "-s", "4", "-f", "png"],
                       capture_output=True, text=True)
        print(f"legacy {model} {k}: {len(os.listdir(od))} files {time.time()-t0:.1f}s", flush=True)


if __name__ == "__main__":
    which = sys.argv[1:] or list(CONFIGS) + ["legacy"]
    for n in which:
        if n == "legacy":
            for m in LEGACY:
                run_legacy(m)
        else:
            run_refined(n, CONFIGS[n])

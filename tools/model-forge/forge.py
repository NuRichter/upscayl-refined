"""Model forge: turns upstream ONNX super-resolution checkpoints into the
graphs the Refined engine runs.

Passes (each optional, applied in this order):
  io32      give the graph float32 inputs/outputs (wraps fp16 I/O with Cast)
  cubic     replace bicubic Resize nodes by an exact Pad + grouped Conv +
            DepthToSpace equivalent (DirectML has no GPU kernel for cubic
            Resize and silently falls back to the CPU)
  blend     network interpolation (DNI) between two checkpoints that share a
            graph; the mix factor becomes a runtime input called "detail"
  fidelity  append a low-frequency fidelity head; runtime input "fidelity"
            = [chroma, luma] weights in 0..1
  fp16      float16 weights/compute, float32 graph I/O

usage:
  python -I forge.py --src a.onnx [--blend b.onnx] [--fidelity] [--fp16]
                     [--name out_name] --out dir
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

# --------------------------------------------------------------------------
# helpers


def _uniq(model: onnx.ModelProto, base: str) -> str:
    used = {n.name for n in model.graph.node}
    used |= {o for n in model.graph.node for o in n.output}
    used |= {i.name for i in model.graph.initializer}
    used |= {i.name for i in model.graph.input}
    k = 0
    name = base
    while name in used:
        k += 1
        name = f"{base}_{k}"
    return name


def _add_init(model: onnx.ModelProto, base: str, arr: np.ndarray) -> str:
    name = _uniq(model, base)
    model.graph.initializer.append(numpy_helper.from_array(arr, name))
    return name


def model_scale(path_or_model) -> int:
    """Measure the integer upscale factor by running a tiny input on CPU."""
    import onnxruntime as ort

    data = (
        path_or_model.SerializeToString()
        if isinstance(path_or_model, onnx.ModelProto)
        else path_or_model
    )
    sess = ort.InferenceSession(data, providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    dtype = np.float16 if "float16" in inp.type else np.float32
    x = np.full((1, 3, 32, 32), 0.5, dtype=dtype)
    y = sess.run(None, {inp.name: x})[0]
    return int(round(y.shape[-1] / 32))


# --------------------------------------------------------------------------
# io32


def pass_io32(model: onnx.ModelProto) -> onnx.ModelProto:
    g = model.graph
    for inp in g.input:
        tt = inp.type.tensor_type
        if tt.elem_type != TensorProto.FLOAT16:
            continue
        old = inp.name
        new = _uniq(model, old + "_f16")
        for n in g.node:
            for i, x in enumerate(n.input):
                if x == old:
                    n.input[i] = new
        g.node.insert(0, helper.make_node("Cast", [old], [new], to=TensorProto.FLOAT16))
        tt.elem_type = TensorProto.FLOAT
    for out in g.output:
        tt = out.type.tensor_type
        if tt.elem_type != TensorProto.FLOAT16:
            continue
        old = out.name
        new = _uniq(model, old + "_f16")
        for n in g.node:
            for i, x in enumerate(n.output):
                if x == old:
                    n.output[i] = new
            for i, x in enumerate(n.input):
                if x == old:
                    n.input[i] = new
        g.node.append(helper.make_node("Cast", [new], [old], to=TensorProto.FLOAT))
        tt.elem_type = TensorProto.FLOAT
    del g.value_info[:]
    return model


# --------------------------------------------------------------------------
# cubic -> conv


def cubic_kernel(scale: int, a: float = -0.75) -> np.ndarray:
    """(scale, 5) taps: weights for phase r over LR offsets -2..2, matching
    ONNX Resize(cubic, half_pixel, exclude_outside=0) with clamped borders."""

    def w(x: float) -> float:
        x = abs(x)
        if x <= 1:
            return (a + 2) * x**3 - (a + 3) * x**2 + 1
        if x < 2:
            return a * x**3 - 5 * a * x**2 + 8 * a * x - 4 * a
        return 0.0

    k = np.zeros((scale, 5), dtype=np.float64)
    for r in range(scale):
        off = (r + 0.5) / scale - 0.5
        fl = math.floor(off)
        for t in range(-1, 3):
            j = fl + t
            k[r, j + 2] += w(off - j)
    return k


def emit_cubic_up(model: onnx.ModelProto, x: str, scale: int, a: float, prefix: str,
                  dtype=np.float32) -> tuple[list, str]:
    """Nodes that upsample NCHW-3ch tensor x by `scale` (exact bicubic)."""
    k = cubic_kernel(scale, a)
    wts = np.zeros((3 * scale * scale, 1, 5, 5), dtype=np.float64)
    for c in range(3):
        for i in range(scale):
            for j in range(scale):
                wts[c * scale * scale + i * scale + j, 0] = np.outer(k[i], k[j])
    w_name = _add_init(model, prefix + "_w", wts.astype(dtype))
    pads = _add_init(model, prefix + "_pads", np.array([0, 0, 2, 2, 0, 0, 2, 2], np.int64))
    p_out = _uniq(model, prefix + "_pad")
    c_out = _uniq(model, prefix + "_conv")
    y = _uniq(model, prefix + "_up")
    nodes = [
        helper.make_node("Pad", [x, pads], [p_out], mode="edge", name=p_out),
        helper.make_node("Conv", [p_out, w_name], [c_out], group=3, kernel_shape=[5, 5],
                         name=c_out),
        helper.make_node("DepthToSpace", [c_out], [y], blocksize=scale, mode="CRD", name=y),
    ]
    return nodes, y


def pass_cubic(model: onnx.ModelProto, scale: int) -> tuple[onnx.ModelProto, int]:
    g = model.graph
    replaced = 0
    new_nodes = []
    for n in g.node:
        if n.op_type == "Resize":
            attrs = {a.name: helper.get_attribute_value(a) for a in n.attribute}
            mode = attrs.get("mode", b"nearest")
            ctm = attrs.get("coordinate_transformation_mode", b"half_pixel")
            if (mode == b"cubic" and ctm in (b"half_pixel", b"pytorch_half_pixel")
                    and attrs.get("exclude_outside", 0) == 0
                    and attrs.get("antialias", 0) == 0):
                a = float(attrs.get("cubic_coeff_a", -0.75))
                nodes, y = emit_cubic_up(model, n.input[0], scale, a, "cubic_up")
                # rename the produced tensor to the Resize output name
                nodes[-1].output[0] = n.output[0]
                new_nodes.extend(nodes)
                replaced += 1
                continue
        new_nodes.append(n)
    del g.node[:]
    g.node.extend(new_nodes)
    return model, replaced


# --------------------------------------------------------------------------
# blend (network interpolation with a runtime factor)


def pass_blend(model: onnx.ModelProto, other: onnx.ModelProto) -> tuple[onnx.ModelProto, int]:
    ga, gb = model.graph, other.graph
    if [n.op_type for n in ga.node] != [n.op_type for n in gb.node]:
        raise SystemExit("blend: graphs differ, cannot interpolate")
    ib = {i.name: numpy_helper.to_array(i) for i in gb.initializer}
    detail = "detail"
    ga.input.append(helper.make_tensor_value_info(detail, TensorProto.FLOAT, [1]))
    keep, blended = [], 0
    mix_nodes = []
    for init in ga.initializer:
        wa = numpy_helper.to_array(init)
        wb = ib.get(init.name)
        if (wb is None or wa.dtype != np.float32 or wa.shape != wb.shape
                or wa.size < 2 or np.array_equal(wa, wb)):
            keep.append(init)
            continue
        base = init.name
        a_name = base + "__a"
        d_name = base + "__d"
        keep.append(numpy_helper.from_array(wa, a_name))
        keep.append(numpy_helper.from_array((wb - wa).astype(np.float32), d_name))
        t = base + "__t"
        mix_nodes.append(helper.make_node("Mul", [d_name, detail], [t]))
        mix_nodes.append(helper.make_node("Add", [a_name, t], [base]))
        blended += 1
    del ga.initializer[:]
    ga.initializer.extend(keep)
    nodes = list(ga.node)
    del ga.node[:]
    ga.node.extend(mix_nodes + nodes)
    return model, blended


# --------------------------------------------------------------------------
# fidelity head


def pass_fidelity(model: onnx.ModelProto, scale: int, levels: int = 5) -> onnx.ModelProto:
    """out = sr + c*(D - Y(D)) + l*Y(D), D = low(up(lr)) - low(sr).

    low() is an a-trous B3-spline pyramid (dilations 1..2^(levels-1)) with
    edge padding. c and l come from the runtime input "fidelity" ([2])."""
    g = model.graph
    lr = g.input[0].name
    sr_old = g.output[0].name
    sr = _uniq(model, "sr_raw")
    for n in g.node:
        for i, x in enumerate(n.output):
            if x == sr_old:
                n.output[i] = sr
    fid = "fidelity"
    g.input.append(helper.make_tensor_value_info(fid, TensorProto.FLOAT, [2]))

    nodes, up = emit_cubic_up(model, lr, scale, -0.75, "fid_up")
    k1 = np.array([1, 2, 1], np.float64) / 4
    k2 = np.outer(k1, k1)
    kw = np.repeat(k2[None, None], 3, axis=0).astype(np.float32)  # (3,1,3,3)
    kw_name = _add_init(model, "fid_blur", kw)

    def low(x: str, tag: str) -> str:
        cur = x
        for lv in range(levels):
            d = 2**lv
            pads = _add_init(model, f"fid_pads_{d}", np.array([0, 0, d, d, 0, 0, d, d], np.int64))
            p = _uniq(model, f"{tag}_p{lv}")
            c = _uniq(model, f"{tag}_c{lv}")
            nodes.append(helper.make_node("Pad", [cur, pads], [p], mode="edge"))
            nodes.append(helper.make_node("Conv", [p, kw_name], [c], group=3,
                                          kernel_shape=[3, 3], dilations=[d, d]))
            cur = c
        return cur

    l_up = low(up, "fid_lu")
    l_sr = low(sr, "fid_ls")
    D = _uniq(model, "fid_D")
    nodes.append(helper.make_node("Sub", [l_up, l_sr], [D]))
    # luma of D (BT.601) via 1x1 conv to 1 channel
    yw = _add_init(model, "fid_yw", np.array([0.299, 0.587, 0.114], np.float32).reshape(1, 3, 1, 1))
    Y = _uniq(model, "fid_Y")
    nodes.append(helper.make_node("Conv", [D, yw], [Y], kernel_shape=[1, 1]))
    chroma = _uniq(model, "fid_chroma")
    nodes.append(helper.make_node("Sub", [D, Y], [chroma]))
    # split fidelity -> c, l  (shape [1] each, broadcast)
    c_idx = _add_init(model, "fid_ci", np.array([0], np.int64))
    l_idx = _add_init(model, "fid_li", np.array([1], np.int64))
    c_w = _uniq(model, "fid_c")
    l_w = _uniq(model, "fid_l")
    nodes.append(helper.make_node("Gather", [fid, c_idx], [c_w], axis=0))
    nodes.append(helper.make_node("Gather", [fid, l_idx], [l_w], axis=0))
    t1 = _uniq(model, "fid_t1")
    t2 = _uniq(model, "fid_t2")
    s1 = _uniq(model, "fid_s1")
    s2 = _uniq(model, "fid_s2")
    nodes.append(helper.make_node("Mul", [chroma, c_w], [t1]))
    nodes.append(helper.make_node("Mul", [Y, l_w], [t2]))
    nodes.append(helper.make_node("Add", [sr, t1], [s1]))
    nodes.append(helper.make_node("Add", [s1, t2], [s2]))
    lo = _add_init(model, "fid_lo", np.array(0.0, np.float32))
    hi = _add_init(model, "fid_hi", np.array(1.0, np.float32))
    nodes.append(helper.make_node("Clip", [s2, lo, hi], [sr_old]))
    g.node.extend(nodes)
    del g.value_info[:]
    return model


# --------------------------------------------------------------------------
# fp16


def _single_consumer_inputs(model: onnx.ModelProto) -> None:
    """Route every graph input through one Identity so the fp16 converter
    inserts exactly one Cast per input (it emits duplicate names otherwise)."""
    g = model.graph
    for inp in g.input:
        alias = _uniq(model, inp.name + "_in")
        for n in g.node:
            for i, x in enumerate(n.input):
                if x == inp.name:
                    n.input[i] = alias
        g.node.insert(0, helper.make_node("Identity", [inp.name], [alias]))


def pass_fp16(model: onnx.ModelProto) -> onnx.ModelProto:
    import warnings

    from onnxconverter_common import float16

    warnings.filterwarnings("ignore", category=UserWarning)
    _single_consumer_inputs(model)
    model = float16.convert_float_to_float16(
        model,
        keep_io_types=True,
        disable_shape_infer=True,
        op_block_list=BLOCKED,
    )
    return _fix_float_casts(model)


BLOCKED = ["Range", "Shape", "ConstantOfShape", "Resize"]


def _fix_float_casts(model: onnx.ModelProto) -> onnx.ModelProto:
    """Shape arithmetic such as `Shape -> Cast(float) -> Pow` survives the
    converter as float32 and then meets float16 activations. Retarget those
    casts to float16 unless they feed a blocked op or a graph output."""
    g = model.graph
    outs = {o.name for o in g.output}
    consumers: dict = {}
    for n in g.node:
        for i in n.input:
            consumers.setdefault(i, []).append(n)
    fixed = 0
    for n in g.node:
        if n.op_type != "Cast":
            continue
        to = next((a for a in n.attribute if a.name == "to"), None)
        if to is None or to.i != TensorProto.FLOAT:
            continue
        out = n.output[0]
        users = consumers.get(out, [])
        if out in outs or not users or any(u.op_type in BLOCKED or u.op_type == "Cast" for u in users):
            continue
        to.i = TensorProto.FLOAT16
        fixed += 1
    del g.value_info[:]
    return model


def self_check(path: str) -> None:
    """Load with ONNX Runtime and run a 40x40 probe; fail the build otherwise."""
    import onnxruntime as ort

    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    feeds = {}
    for i in sess.get_inputs():
        if i.name == "detail":
            feeds[i.name] = np.array([0.5], np.float32)
        elif i.name == "fidelity":
            feeds[i.name] = np.array([1.0, 0.0], np.float32)
        else:
            feeds[i.name] = np.full((1, 3, 40, 40), 0.5, np.float32)
    y = sess.run(None, feeds)[0]
    if not np.isfinite(y).all():
        raise SystemExit(f"self-check: non-finite output from {path}")


# --------------------------------------------------------------------------


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--blend")
    ap.add_argument("--fidelity", action="store_true")
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--no-cubic", action="store_true")
    ap.add_argument("--name")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    model = onnx.load(args.src)
    report = {"src": os.path.basename(args.src)}
    model = pass_io32(model)
    scale = model_scale(model)
    report["scale"] = scale
    if not args.no_cubic:
        model, n = pass_cubic(model, scale)
        report["cubic_rewritten"] = n
    if args.blend:
        other = pass_io32(onnx.load(args.blend))
        if not args.no_cubic:
            other, _ = pass_cubic(other, scale)
        model, n = pass_blend(model, other)
        report["blend_with"] = os.path.basename(args.blend)
        report["blended_tensors"] = n
    if args.fidelity:
        model = pass_fidelity(model, scale)
        report["fidelity_head"] = True
    if args.fp16:
        model = pass_fp16(model)
        report["fp16"] = True
    model.producer_name = "upscayl-refined-forge"
    onnx.checker.check_model(model)
    os.makedirs(args.out, exist_ok=True)
    name = args.name or os.path.splitext(os.path.basename(args.src))[0] + ".refined"
    out = os.path.join(args.out, name + ".onnx")
    onnx.save(model, out)
    self_check(out)
    report["out"] = out
    report["bytes"] = os.path.getsize(out)
    report["sha256"] = sha256(out)
    report["inputs"] = [i.name for i in model.graph.input]
    print(json.dumps(report))


if __name__ == "__main__":
    main()

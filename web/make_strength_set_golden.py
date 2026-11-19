"""Golden fixtures for the browser strength-set export (web/lib/strength-set.js, level 1h).

The source of truth is strength.scaled + np3.serialize. The browser rules mirrored here
(spec/ui.md "Save a strength set", Decisions #1 and #5):
  - every member is an independent scaled(base, p) from the base, never chained;
  - at 100% the member is the base itself (byte-exact round-trip, as the single export);
  - the NP3 internal name stays the base name (no "-p" suffix inside the NP3);
  - file name "<stem>-<p>.NP3", stem = the name with < > : " / \\ | ? * and control chars
    replaced by "_", surrounding spaces/dots trimmed, "profile" if empty;
  - percents: integers 0..150, deduplicated, ascending; anything else is rejected.

    python3 web/make_strength_set_golden.py   ->  web/golden/strength-set/index.json

Field-level diagnostics on a mismatch come from deserializing the expected bytes in the
test (np3 deserialization is itself verified by level 4). Imports only numpy (via strength/make_pack) — no scipy needed.
"""
from __future__ import annotations

import base64
import dataclasses
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import np3  # noqa: E402
import strength  # noqa: E402

OUT = os.path.join(HERE, "golden", "strength-set")
DEFAULT = [30, 50, 70, 100]


def from_json(d: dict) -> np3.Control:
    kw = dict(d)
    kw["blender"] = {k: tuple(v) for k, v in d["blender"].items()}
    kw["grade"] = {k: tuple(v) for k, v in d["grade"].items()}
    kw["curve"] = None if d["curve"] is None else np3.Curve(
        raw=list(d["curve"]["raw"]), points=[tuple(p) for p in d["curve"]["points"]])
    return np3.Control(**kw)


def stem(name: str) -> str:
    s = re.sub(r'[\x00-\x1f<>:"/\\|?*\x7f]', "_", name)
    s = re.sub(r"^[\s.]+|[\s.]+$", "", s)
    return s or "profile"


def normalize(percents) -> list[int]:
    if not percents:
        raise ValueError("no percents")
    out = set()
    for v in percents:
        if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 150:
            raise ValueError(f"invalid percent {v!r}")
        out.add(v)
    return sorted(out)


def member(base: np3.Control, base_bytes: bytes, p: int) -> bytes:
    if p == 100:
        return base_bytes
    c = strength.scaled(base, p, base.name)
    data = np3.serialize(c)
    assert np3.serialize(np3.deserialize(data)) == data
    return data


def bases() -> list[tuple[str, bytes]]:
    """(key, NP3 bytes): fitted controls (golden/fit), official samples (curve+comment,
    no curve, long comment), a reserved-character name and a 19-char name."""
    out = []
    for f in ("single", "two"):
        d = json.load(open(os.path.join(HERE, "golden", "fit", f + ".json")))["control"]
        out.append((f"fit-{f}", np3.serialize(from_json(d))))
    for s in ("comment-a-tonecurve", "vanilla", "longest-comment", "tonecurve-black"):
        out.append((s, open(os.path.join(ROOT, "third_party", "samples", s + ".NP3"), "rb").read()))
    d = json.load(open(os.path.join(HERE, "golden", "fit", "single.json")))["control"]
    for key, name in (("reserved-chars", ' A/B:C*?. '), ("name-19", "ABCDEFGHIJKLMNOPQRS"), ("dots", "...")):
        out.append((key, np3.serialize(dataclasses.replace(from_json(d), name=name))))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    sets = [DEFAULT, [150, 0, 70, 70, 100], [100], [1, 149]]
    cases, base_doc = [], {}
    for key, raw in bases():
        base_doc[key] = base64.b64encode(raw).decode()
        base = np3.deserialize(raw)
        base_bytes = np3.serialize(base)
        assert base_bytes == raw, f"{key}: base does not round-trip"
        for ps in sets:
            members = []
            for p in normalize(ps):
                data = member(base, base_bytes, p)
                c = np3.deserialize(data)
                assert c.name == base.name
                members.append({"percent": p, "fileName": f"{stem(base.name)}-{p}.NP3",
                                "bytes": base64.b64encode(data).decode()})
            names = [m["fileName"].lower() for m in members]
            assert len(set(names)) == len(names)
            cases.append({"base": key, "percents": ps, "members": members})
    rejected = [[], [151], [-1], [12.5], ["abc"], [30, 200]]
    for ps in rejected:
        try:
            normalize(ps)
            raise AssertionError(f"{ps} must be rejected")
        except ValueError:
            pass
    doc = {"schemaVersion": 1, "generator": "web/make_strength_set_golden.py",
           "default": DEFAULT, "bases": base_doc, "cases": cases, "rejected": rejected}
    path = os.path.join(OUT, "index.json")
    json.dump(doc, open(path, "w"), ensure_ascii=False)
    print(f"strength-set: {len(cases)} cases, {sum(len(c['members']) for c in cases)} members, "
          f"{len(rejected)} rejections -> {os.path.relpath(path, ROOT)} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()

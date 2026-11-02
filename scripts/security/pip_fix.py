#!/usr/bin/env python3
"""Correzioni di sicurezza pip per services/pdf-extractor (requirements.in → requirements.txt con hash).

Stesse regole di scripts/security/choose-version.mjs: versione corretta più bassa (stessa major
prima), età minima 48h, provenienza "mai un downgrade di fiducia" (attestazioni PEP 740 dalla
Integrity API di PyPI; gli hash in requirements.txt restano obbligatori).

  python scripts/security/pip_fix.py --fixes fixes.json --dir services/pdf-extractor --out result.json [--dry-run]
  fixes.json: [{"pkg", "current", "vulnerable_ranges": ["<x"], "ghsa": [...], "force_version"?}]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

MIN_AGE_HOURS = 48
COMPILE_FLAGS = ["--allow-unsafe", "--generate-hashes", "--no-emit-index-url", "--strip-extras", "-q"]


def _v(s):
    try:
        return Version(s)
    except InvalidVersion:
        return None


def _trusted(cand, previous):
    repos = {p["provenance_repo"].lower() for p in previous if p.get("provenance_repo")}
    if not repos:
        return True
    return bool(cand.get("provenance_repo")) and cand["provenance_repo"].lower() in repos


def choose_version(current, vulnerable_specs, candidates, previous, now, min_age_hours=MIN_AGE_HOURS, force_version=None):
    cur = Version(current)
    specs = [SpecifierSet(s.replace(" ", ",")) for s in vulnerable_specs]
    fixing = []
    for c in candidates:
        v = _v(c["version"])
        if v is None or v.is_prerelease or v.is_devrelease or v <= cur:
            continue
        if any(s.contains(v, prereleases=True) for s in specs):
            continue
        fixing.append((0 if v.major == cur.major else 1, v, c))
    fixing.sort(key=lambda t: (t[0], t[1]))

    if force_version:
        f = next((c for _, _, c in fixing if c["version"] == force_version), None)
        if f is None:
            return {"action": "unfixable", "reason": f"versione forzata {force_version} non corregge"}
        if not _trusted(f, previous):
            return {"action": "unfixable", "reason": "provenienza assente o diversa"}
        return {"action": "fix", "version": f["version"]}

    if not fixing:
        return {"action": "unfixable", "reason": "nessuna versione corretta"}

    min_age = timedelta(hours=min_age_hours)
    first_young = None
    saw_untrusted = saw_undated = False
    for _, _, c in fixing:
        if not _trusted(c, previous):
            saw_untrusted = True
            continue
        if c["published_at"] is None:
            saw_undated = True
            continue
        if now - c["published_at"] >= min_age:
            return {"action": "fix", "version": c["version"]}
        first_young = first_young or c
    if first_young:
        return {"action": "pending", "version": first_young["version"], "eta": first_young["published_at"] + min_age}
    if saw_undated:
        return {"action": "unfixable", "reason": "data di pubblicazione sconosciuta"}
    if saw_untrusted:
        return {"action": "unfixable", "reason": "provenienza assente o diversa"}
    return {"action": "unfixable", "reason": "nessuna versione corretta"}


# ── requirements.in ─────────────────────────────────────────────────────────────────────────
_REQ = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?P<extras>\[[^\]]*\])?\s*==\s*(?P<ver>\S+)\s*$")


def _match(line, pkg):
    m = _REQ.match(line)
    return m if m and canonicalize_name(m["name"]) == canonicalize_name(pkg) else None


def is_direct(text, pkg):
    return any(_match(l, pkg) for l in text.splitlines())


def set_direct_pin(text, pkg, version):
    out = []
    for line in text.splitlines(keepends=True):
        m = _match(line.rstrip("\r\n"), pkg)
        if m:
            eol = line[len(line.rstrip("\r\n")):]
            line = f"{m['name']}{m['extras'] or ''}=={version}{eol}"
        out.append(line)
    return "".join(out)


def add_transitive_pin(text, pkg, version, ghsa, date):
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if _match(line.rstrip("\r\n"), pkg):
            eol = line[len(line.rstrip("\r\n")):]
            lines[i] = f"{pkg}=={version}{eol}"
            if i > 0 and "security-autofix" in lines[i - 1]:
                lines[i - 1] = f"# {' '.join(ghsa)} ({date}, security-autofix): rimuovere quando il padre si aggiorna{eol}"
            return "".join(lines)
    body = text if text.endswith("\n") or not text else text + "\n"
    return (f"{body}# {' '.join(ghsa)} ({date}, security-autofix): rimuovere quando il padre si aggiorna\n"
            f"{pkg}=={version}\n")


# ── PyPI ────────────────────────────────────────────────────────────────────────────────────
def _get_json(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"Accept": accept})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _provenance_repo(pkg, version, filename):
    try:
        d = _get_json(f"https://pypi.org/integrity/{pkg}/{version}/{filename}/provenance",
                      "application/vnd.pypi.integrity.v1+json")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    for b in d.get("attestation_bundles", []):
        pub = b.get("publisher") or {}
        if pub.get("repository"):
            return pub["repository"]
    return None


def fetch_candidates(pkg, current):
    d = _get_json(f"https://pypi.org/pypi/{pkg}/json")
    cur = Version(current)
    cands, older = [], []
    for ver, files in d.get("releases", {}).items():
        v = _v(ver)
        files = [f for f in files if not f.get("yanked")]
        if v is None or not files:
            continue
        times = [f.get("upload_time_iso_8601") for f in files if f.get("upload_time_iso_8601")]
        published = min(datetime.fromisoformat(t.replace("Z", "+00:00")) for t in times) if times else None
        entry = {"version": ver, "published_at": published, "provenance_repo": None, "_file": files[0]["filename"]}
        (cands if v > cur else older).append((v, entry))
    cands.sort(key=lambda t: t[0])
    older.sort(key=lambda t: t[0])
    # Provenance delle ultime 3 precedenti (current compresa): basta una per fissare il repository.
    previous = []
    for _, e in older[-3:]:
        e["provenance_repo"] = _provenance_repo(pkg, e["version"], e["_file"])
        previous.append(e)
    if any(p["provenance_repo"] for p in previous):
        for _, e in [t for t in cands if not t[0].is_prerelease][:20]:
            e["provenance_repo"] = _provenance_repo(pkg, e["version"], e["_file"])
    return [e for _, e in cands], previous


# ── pip-compile ─────────────────────────────────────────────────────────────────────────────
def _compile(dirpath, src, out, upgrade=None):
    cmd = [sys.executable, "-m", "piptools", "compile", *COMPILE_FLAGS, "-o", out, src]
    if upgrade:
        cmd += ["--upgrade-package", upgrade]
    return subprocess.run(cmd, cwd=dirpath, capture_output=True, text=True)


def _locked(dirpath, out, pkg):
    p = Path(dirpath) / out
    return next((m["ver"] for l in p.read_text(encoding="utf8").splitlines() if (m := _match(l.split(" \\")[0], pkg))), None)


def apply(dirpath, pkg, version, ghsa, date):
    d = Path(dirpath)
    locked = _locked(d, "requirements.txt", pkg)
    if locked and _v(locked) and _v(locked) >= Version(version):
        raise RuntimeError(f"{pkg}: lockfile già a {locked}, {version} sarebbe un downgrade")
    req_in = d / "requirements.in"
    text = req_in.read_text(encoding="utf8")
    if is_direct(text, pkg):
        req_in.write_text(set_direct_pin(text, pkg, version), encoding="utf8", newline="")
        r = _compile(d, "requirements.in", "requirements.txt", upgrade=f"{pkg}=={version}")
        kind = "direct"
    else:
        r = _compile(d, "requirements.in", "requirements.txt", upgrade=f"{pkg}=={version}")
        kind = "upgrade"
        if r.returncode != 0 or _locked(d, "requirements.txt", pkg) != version:
            req_in.write_text(add_transitive_pin(text, pkg, version, ghsa, date), encoding="utf8", newline="")
            r = _compile(d, "requirements.in", "requirements.txt", upgrade=f"{pkg}=={version}")
            kind = "pin"
    if r.returncode != 0 or _locked(d, "requirements.txt", pkg) != version:
        raise RuntimeError(f"pip-compile non ha portato {pkg} a {version}: {r.stderr.strip()[-500:]}")
    if (d / "requirements-dev.in").exists() and _locked(d, "requirements-dev.txt", pkg):
        r = _compile(d, "requirements-dev.in", "requirements-dev.txt", upgrade=f"{pkg}=={version}")
        if r.returncode != 0:
            raise RuntimeError(f"requirements-dev.txt: {r.stderr.strip()[-500:]}")
    return kind


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixes", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    date = now.date().isoformat()
    results = []
    for f in json.loads(Path(a.fixes).read_text(encoding="utf8")):
        try:
            cands, prev = fetch_candidates(f["pkg"], f["current"])
            r = choose_version(f["current"], f["vulnerable_ranges"], cands, prev, now, force_version=f.get("force_version"))
        except Exception as e:  # registry irraggiungibile: mai una versione senza verifica
            r = {"action": "unfixable", "reason": f"registry: {e}"}
        if r["action"] == "fix" and not a.dry_run:
            try:
                r["kind"] = apply(a.dir, f["pkg"], r["version"], f.get("ghsa", []), date)
            except Exception as e:
                r = {"action": "unfixable", "reason": str(e)}
        if "eta" in r:
            r["eta"] = r["eta"].isoformat()
        results.append({"pkg": f["pkg"], "current": f["current"], "ghsa": f.get("ghsa", []), **r})
    Path(a.out).write_text(json.dumps(results, indent=1), encoding="utf8")
    print(json.dumps(results))


if __name__ == "__main__":
    main()

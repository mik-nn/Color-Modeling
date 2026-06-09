"""
Minimal Python ICM/CxF reader.

Extracts per-patch spectral reflectance + RGB device values from Epson P9000
ICC profiles. Two embedded-data formats are supported:

  1. ZXML/CxF tag (b'CxF '): X-Rite/i1Profiler CxF3 spectral XML embedded via
     zlib-compressed ZXML — used by BC profiles.

  2. `targ` tag (b'targ'): CGATS.17 text embedded in an ICC `text` tag — used
     by MOAB profiles (basICColor / similar RIP).

Both formats yield the same dict contract:
  { 'full_name': str, 'patches': list[dict], 'paper_spectrum': list[float] }

Parsing notes (from project MEMORY.md):
  - ICC tag count: byte 128 (not 132)
  - Tag table entries start at byte 132
  - CxF tag signature: b'CxF '  (4 bytes)
  - ZXML data-type: b'ZXML'
  - Skip 12 bytes after tag data start, then zlib.decompress → UTF-8 XML
  - CxF namespace: cc:CxF (X-Rite/i1Profiler)
  - targ tag: `text` type (first 8 bytes = type + reserved), then CGATS.17 text
    Columns: RGB_R RGB_G RGB_B SPECTRAL_NM_380 … SPECTRAL_NM_730
"""

from __future__ import annotations

import re
import struct
import zlib
from pathlib import Path

# defusedxml prevents XXE and billion-laughs attacks; used even for trusted ICM
# files because the ZXML payload is third-party vendor data (X-Rite/i1Profiler).
import defusedxml.ElementTree as ET


CC = "http://www.color.org/colorexchange"   # cc: namespace URI


# ---------------------------------------------------------------------------
# Internal: ICC tag table helpers
# ---------------------------------------------------------------------------

def _iter_tags(buf: bytes):
    """Yield (signature_bytes, data_bytes) for every tag in the ICC buffer."""
    n_tags = struct.unpack_from(">I", buf, 128)[0]
    for i in range(n_tags):
        off = 132 + i * 12
        sig   = buf[off:off+4]
        start = struct.unpack_from(">I", buf, off+4)[0]
        size  = struct.unpack_from(">I", buf, off+8)[0]
        yield sig, buf[start:start+size]


# ---------------------------------------------------------------------------
# Path 1: ZXML / CxF (BC profiles)
# ---------------------------------------------------------------------------

def _find_zxml(buf: bytes) -> bytes | None:
    """Locate the ZXML CxF tag in an ICC binary buffer, return raw compressed bytes."""
    for sig, data in _iter_tags(buf):
        if sig == b"CxF ":
            # First 4 bytes: data type 'ZXML'; next 8 bytes: reserved/unknown.
            # Compressed payload starts at byte 12.
            if data[:4] == b"ZXML" and len(data) > 12:
                return data[12:]
    return None


NS = {"cc": CC}

# CxF3-core namespace used by BC profiles (newer format).
_CC3 = "http://colorexchangeformat.com/CxF3-core"


def _parse_cxf_xml(xml_text: str) -> list[dict]:
    """
    Parse CxF XML → list of patch dicts:
      { 'rgb': [R,G,B], 'spectrum': [f0..f35], 'sample_id': str }

    Supports two namespace variants:
      - http://www.color.org/colorexchange  (old cc: format, X-Rite/i1Profiler)
      - http://colorexchangeformat.com/CxF3-core  (BC profiles, CxF3 standard)

    In CxF3-core, Target objects hold RGB and Measurement objects hold spectra;
    they are joined by (Row, Column, Page) Tag values.
    In the old cc: format, each Object contains both DeviceColorValues and
    SpectralReflectance.
    """
    root = ET.fromstring(xml_text)
    ns = root.tag.split("}")[0].lstrip("{") if "}" in root.tag else CC
    patches: list[dict] = []

    if ns == _CC3:
        # CxF3-core: Target objects for RGB, Measurement objects for spectra,
        # joined on (Row, Column, Page) Tag values.
        def _rcp(obj) -> tuple[str, str, str]:
            r = c = p = ""
            for t in obj.iter(f"{{{_CC3}}}Tag"):
                n = t.get("Name", "")
                v = t.get("Value", "")
                if n == "Row":    r = v
                elif n == "Column": c = v
                elif n == "Page":   p = v
            return r, c, p or "1"

        rgb_by_key: dict[tuple, list[int]] = {}
        for obj in root.iter(f"{{{_CC3}}}Object"):
            if obj.get("ObjectType") != "Target":
                continue
            rgb_el = obj.find(f".//{{{_CC3}}}ColorRGB")
            if rgb_el is None:
                continue
            try:
                r_el = rgb_el.find(f"{{{_CC3}}}R")
                g_el = rgb_el.find(f"{{{_CC3}}}G")
                b_el = rgb_el.find(f"{{{_CC3}}}B")
                if r_el is None or g_el is None or b_el is None:
                    continue
                r_v = round(float(r_el.text or "0"))
                g_v = round(float(g_el.text or "0"))
                b_v = round(float(b_el.text or "0"))
            except (ValueError, AttributeError):
                continue
            rgb_by_key[_rcp(obj)] = [r_v, g_v, b_v]

        spec_by_key: dict[tuple, list[float]] = {}
        for obj in root.iter(f"{{{_CC3}}}Object"):
            if "Measurement" not in obj.get("ObjectType", ""):
                continue
            refl = obj.find(f".//{{{_CC3}}}ReflectanceSpectrum")
            if refl is None:
                continue
            vals = [float(x) for x in (refl.text or "").split() if x]
            if len(vals) >= 10:
                spec_by_key[_rcp(obj)] = vals

        for key, rgb in rgb_by_key.items():
            if key not in spec_by_key:
                continue
            r_str, c_str, p_str = key
            patches.append({
                "sample_id": f"R{r_str}C{c_str}P{p_str}",
                "rgb": rgb,
                "spectrum": spec_by_key[key],
            })

    else:
        # Old cc: namespace — each Object contains both DeviceColorValues and
        # SpectralReflectance.
        for obj in root.iter(f"{{{CC}}}Object"):
            rgb: list[float] | None = None
            spectrum: list[float] | None = None
            sample_id = obj.get("Name", "")

            for cv in obj.iter(f"{{{CC}}}ColorValues"):
                for dv in cv.iter(f"{{{CC}}}DeviceColorValues"):
                    r = g = b = None
                    for ch in dv:
                        tag = ch.tag.split("}")[-1]
                        try:
                            val = float(ch.text or "")
                        except ValueError:
                            continue
                        if tag in ("RGB_R", "SAMPLE_R"):
                            r = val
                        elif tag in ("RGB_G", "SAMPLE_G"):
                            g = val
                        elif tag in ("RGB_B", "SAMPLE_B"):
                            b = val
                    if r is not None and g is not None and b is not None:
                        rgb = [r, g, b]

            for sr in obj.iter(f"{{{CC}}}SpectralReflectance"):
                text = sr.get("Values") or sr.text or ""
                vals = [float(x) for x in text.split() if x]
                if len(vals) >= 10:
                    spectrum = vals

            if rgb is not None and spectrum is not None:
                patches.append({
                    "sample_id": sample_id,
                    "rgb": [round(v) for v in rgb],
                    "spectrum": spectrum,
                })

    return patches


# ---------------------------------------------------------------------------
# Path 2: targ / CGATS.17 (MOAB profiles)
# ---------------------------------------------------------------------------

def _parse_cgats_tag(data: bytes) -> list[dict] | None:
    """
    Parse an ICC `targ` tag (text type, CGATS.17 body).

    Returns list of patch dicts { 'rgb': [R,G,B], 'spectrum': [...], 'sample_id': str }
    or None if tag is not CGATS or has no spectral columns.
    """
    # ICC `text` type: first 4 bytes = 'text', next 4 = reserved; body starts at 8.
    text = data[8:].decode("latin1", errors="replace")
    if "CGATS" not in text:
        return None

    lines = text.replace("\r\n", "\n").replace("\r", "\n").splitlines()

    def find_block(begin: str, end: str) -> list[str]:
        try:
            si = next(i for i, L in enumerate(lines) if L.strip() == begin)
            ei = next(i for i, L in enumerate(lines) if i > si and L.strip() == end)
            return [L for L in lines[si+1:ei] if L.strip()]
        except StopIteration:
            return []

    fmt_lines = find_block("BEGIN_DATA_FORMAT", "END_DATA_FORMAT")
    data_lines = find_block("BEGIN_DATA", "END_DATA")
    if not fmt_lines or not data_lines:
        return None

    fields = fmt_lines[0].split()

    # Locate RGB and spectral columns.
    rgb_r_idx = next((i for i, f in enumerate(fields) if f.upper() == "RGB_R"), -1)
    rgb_g_idx = next((i for i, f in enumerate(fields) if f.upper() == "RGB_G"), -1)
    rgb_b_idx = next((i for i, f in enumerate(fields) if f.upper() == "RGB_B"), -1)
    sample_idx = next((i for i, f in enumerate(fields) if f.upper() == "SAMPLE_ID"), -1)

    spectral_cols: list[tuple[int, int]] = []   # (col_index, wavelength_nm)
    for i, f in enumerate(fields):
        m = re.match(r"^SPECTRAL_NM_(\d+)$", f, re.IGNORECASE)
        if m:
            spectral_cols.append((i, int(m.group(1))))

    if not spectral_cols or rgb_r_idx < 0 or rgb_g_idx < 0 or rgb_b_idx < 0:
        return None

    patches: list[dict] = []
    for row_idx, line in enumerate(data_lines):
        cols = line.split()
        if len(cols) <= max(rgb_r_idx, rgb_g_idx, rgb_b_idx, spectral_cols[-1][0]):
            continue
        try:
            r = round(float(cols[rgb_r_idx]))
            g = round(float(cols[rgb_g_idx]))
            b = round(float(cols[rgb_b_idx]))
            spectrum = [float(cols[ci]) for ci, _ in spectral_cols]
        except (ValueError, IndexError):
            continue

        # Normalise: some CGATS files store 0-100 %, convert to 0-1.
        if max(spectrum) > 1.5:
            spectrum = [v / 100.0 for v in spectrum]

        sid = cols[sample_idx] if sample_idx >= 0 and sample_idx < len(cols) else f"P{row_idx+1:04d}"
        patches.append({
            "sample_id": sid,
            "rgb": [r, g, b],
            "spectrum": spectrum,
        })

    return patches if patches else None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def read_icm(path: str | Path) -> dict | None:
    """
    Read an ICC profile, return:
      { 'full_name': str, 'patches': list[dict], 'paper_spectrum': list[float] }
    Returns None if no usable spectral data found (e.g. metallic without spectra).

    Tries ZXML/CxF first (BC profiles), then targ/CGATS (MOAB profiles).
    """
    buf = Path(path).read_bytes()
    patches: list[dict] | None = None

    # --- Try ZXML / CxF ---
    compressed = _find_zxml(buf)
    if compressed is not None:
        try:
            # Strip null-byte padding that some encoders append after </cc:CxF>.
            xml_text = zlib.decompress(compressed).decode("utf-8").rstrip("\x00")
            patches = _parse_cxf_xml(xml_text)
        except Exception:
            patches = None

    # --- Fall back to targ / CGATS ---
    if not patches:
        for sig, data in _iter_tags(buf):
            if sig == b"targ":
                patches = _parse_cgats_tag(data)
                if patches:
                    break

    if not patches:
        return None

    # Paper white = whitest neutral patch (R≈G≈B, highest total brightness).
    paper_spec: list[float] | None = None
    best_brightness = -1.0
    for p in patches:
        r, g, b = p["rgb"]
        if abs(r - g) < 8 and abs(g - b) < 8:
            brightness = r + g + b
            if brightness > best_brightness:
                best_brightness = brightness
                paper_spec = p["spectrum"]

    if paper_spec is None:
        paper_spec = patches[0]["spectrum"]

    name = Path(path).stem
    return {
        "full_name": name,
        "patches": patches,
        "paper_spectrum": paper_spec,
    }

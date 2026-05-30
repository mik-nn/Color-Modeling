import json
import numpy as np
import os

# Copy constants from frontend/src/lib/colormath.ts
CMF_X = [
  0.001368, 0.004243, 0.014310, 0.043510, 0.134380, 0.283900, 0.348280, 0.336200, 0.290800,
  0.195360, 0.095640, 0.032010, 0.004900, 0.009300, 0.063270, 0.165500, 0.290400, 0.433450,
  0.594500, 0.762100, 0.916300, 1.026300, 1.062200, 1.045600, 0.971600, 0.854450, 0.708600,
  0.574200, 0.415400, 0.302400, 0.218000, 0.143700, 0.095800, 0.063700, 0.041900, 0.028700,
]
CMF_Y = [
  0.000039, 0.000120, 0.000396, 0.001210, 0.004000, 0.011600, 0.023000, 0.038000, 0.060000,
  0.090980, 0.139020, 0.208020, 0.323000, 0.503000, 0.710000, 0.862000, 0.954000, 0.994950,
  0.995000, 0.952000, 0.870000, 0.757000, 0.631000, 0.503000, 0.381000, 0.265000, 0.175000,
  0.107000, 0.061000, 0.032000, 0.017000, 0.008210, 0.004102, 0.002091, 0.001047, 0.000520,
]
CMF_Z = [
  0.006450, 0.020050, 0.067850, 0.207400, 0.645600, 1.385600, 1.747060, 1.772110, 1.669200,
  1.287640, 0.812950, 0.465180, 0.272000, 0.158200, 0.042160, 0.020300, 0.008750, 0.003900,
  0.002100, 0.001650, 0.001100, 0.000800, 0.000340, 0.000190, 0.000050, 0.000020,
  0.000050, 0.000030, 0.000050, 0.000010, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000,
]
D50 = [
  23.942, 28.022, 31.493, 38.031, 43.207, 52.088, 64.458, 67.989, 76.221, 84.854,
  92.023, 97.420, 99.858, 100.000, 97.997, 97.478, 97.746, 97.278, 97.783, 95.756,
  97.434, 96.785, 97.010, 95.785, 95.694, 95.688, 92.949, 89.937, 88.200, 87.244,
  84.374, 82.831, 80.019, 80.460, 79.174, 79.048,
]

def spectra_to_xyz(reflectance, start_wl=380):
    """reflectance: list or array of length L, values 0-1, step 10 nm starting at start_wl"""
    X = Y = Z = 0.0
    for i, R in enumerate(reflectance):
        wl = start_wl + i * 10
        # Find index in D50/CMF arrays (assuming D50 starts at 380 nm)
        idx = (wl - 380) // 10
        if idx < 0 or idx >= len(D50):
            continue
        d = D50[idx]
        X += R * d * CMF_X[int(idx)]
        Y += R * d * CMF_Y[int(idx)]
        Z += R * d * CMF_Z[int(idx)]
    # Normalize? In the TS code, they don't normalize because D50 is already scaled?
    # Actually the TS function returns raw XYZ, not scaled to Y=100.
    # We'll keep as is.
    return [X, Y, Z]

def xyz_to_lab(xyz):
    x, y, z = xyz
    # Reference white D50
    xr = 96.422  # Actually from TS: they use D50 perfect white? We'll compute from D50 and CMF?
    # But the TS function xyzToLab uses hardcoded values? Let's compute from D50 and CMF_Y?
    # We'll compute the white point as XYZ of perfect reflectance (all 1.0)
    # We'll compute it once.
    pass

# We'll compute the white point by calling spectra_to_xyz with reflectance all 1.0
def compute_white_point():
    refl = [1.0] * len(D50)  # assuming D50 length corresponds to number of wavelength steps
    return spectra_to_xyz(refl)

WHITE_POINT = compute_white_point()
print(f"White point (X,Y,Z): {WHITE_POINT}")

def xyz_to_lab(xyz):
    x, y, z = xyz
    xr, yr, zr = WHITE_POINT
    # Apply epsilon and kappa as per CIE 1976
    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    def f(t):
        return t ** (1/3.0) if t > eps else (kappa * t + 16.0) / 116.0
    fx = f(x / xr)
    fy = f(y / yr)
    fz = f(z / zr)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return [L, a, b]

def spectrum_to_lab(spectrum):
    xyz = spectra_to_xyz(spectrum)
    return xyz_to_lab(xyz)

# Load data
with open('../frontend/data/cae-input/profiles-mk.json') as f:
    data = json.load(f)

# Filter WCRW profiles
wcrw_profiles = [p for p in data['profiles'] if p['substrate'] == 'WCRW']
print(f"Found {len(wcrw_profiles)} WCRW profiles")

# For each profile, compute a*b for each patch
for profile in wcrw_profiles:
    name = profile['full_name']
    a_vals = []
    b_vals = []
    for patch in profile['patches']:
        lab = spectrum_to_lab(patch['spectrum'])
        a_vals.append(lab[1])
        b_vals.append(lab[2])
    a_vals = np.array(a_vals)
    b_vals = np.array(b_vals)
    print(f"{name}: a range [{np.min(a_vals):.2f}, {np.max(a_vals):.2f}], b range [{np.min(b_vals):.2f}, {np.max(b_vals):.2f}]")
    # Compute 2D histogram to find maxima
    hist, xedges, yedges = np.histogram2d(a_vals, b_vals, bins=20, range=[[-128, 127], [-128, 127]])
    # Find the bin with maximum count
    max_idx = np.unravel_index(np.argmax(hist), hist.shape)
    a_max = (xedges[max_idx[0]] + xedges[max_idx[0]+1]) / 2
    b_max = (yedges[max_idx[1]] + yedges[max_idx[1]+1]) / 2
    print(f"  Most dense bin: a={a_max:.2f}, b={b_max:.2f}, count={int(hist[max_idx])}")
    # Optionally, find multiple maxima by thresholding
    threshold = hist.max() * 0.2
    peaks = []
    for i in range(hist.shape[0]):
        for j in range(hist.shape[1]):
            if hist[i,j] >= threshold:
                # Check if it's a local maximum (simple: greater than neighbors)
                is_max = True
                for di in [-1,0,1]:
                    for dj in [-1,0,1]:
                        if di == 0 and dj == 0:
                            continue
                        ni, nj = i+di, j+dj
                        if 0 <= ni < hist.shape[0] and 0 <= nj < hist.shape[1]:
                            if hist[ni,nj] > hist[i,j]:
                                is_max = False
                                break
                    if not is_max:
                        break
                if is_max:
                    a_center = (xedges[i] + xedges[i+1]) / 2
                    b_center = (yedges[j] + yedges[j+1]) / 2
                    peaks.append((a_center, b_center, hist[i,j]))
    # Sort peaks by count descending
    peaks.sort(key=lambda x: x[2], reverse=True)
    print(f"  Number of peaks (above 20% of max): {len(peaks)}")
    for idx, (a_p, b_p, cnt) in enumerate(peaks[:5]):
        print(f"    Peak {idx+1}: a={a_p:.2f}, b={b_p:.2f}, count={int(cnt)}")
    print()
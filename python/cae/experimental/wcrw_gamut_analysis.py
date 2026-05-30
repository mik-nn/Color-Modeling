import json
import numpy as np
import os

# Copy constants from frontend/src/lib/colormath.ts
CMF_X = np.array([
  0.001368, 0.004243, 0.014310, 0.043510, 0.134380, 0.283900, 0.348280, 0.336200, 0.290800,
  0.195360, 0.095640, 0.032010, 0.004900, 0.009300, 0.063270, 0.165500, 0.290400, 0.433450,
  0.594500, 0.762100, 0.916300, 1.026300, 1.062200, 1.045600, 0.971600, 0.854450, 0.708600,
  0.574200, 0.415400, 0.302400, 0.218000, 0.143700, 0.095800, 0.063700, 0.041900, 0.028700
])
CMF_Y = np.array([
  0.000039, 0.000120, 0.000396, 0.001210, 0.004000, 0.011600, 0.023000, 0.038000, 0.060000,
  0.090980, 0.139020, 0.208020, 0.323000, 0.503000, 0.710000, 0.862000, 0.954000, 0.994950,
  0.995000, 0.952000, 0.870000, 0.757000, 0.631000, 0.503000, 0.381000, 0.265000, 0.175000,
  0.107000, 0.061000, 0.032000, 0.017000, 0.008210, 0.004102, 0.002091, 0.001047, 0.000520
])
CMF_Z = np.array([
  0.006450, 0.020050, 0.067850, 0.207400, 0.645600, 1.385600, 1.747060, 1.772110, 1.669200,
  1.287640, 0.812950, 0.465180, 0.272000, 0.158200, 0.042160, 0.020300, 0.008750, 0.003900,
  0.002100, 0.001650, 0.001100, 0.000800, 0.000340, 0.000190, 0.000050, 0.000020,
  0.000050, 0.000030, 0.000050, 0.000010, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000
])
D50 = np.array([
  23.942, 28.022, 31.493, 38.031, 43.207, 52.088, 64.458, 67.989, 76.221, 84.854,
  92.023, 97.420, 99.858, 100.000, 97.997, 97.478, 97.746, 97.278, 97.783, 95.756,
  97.434, 96.785, 97.010, 95.785, 95.694, 95.688, 92.949, 89.937, 88.200, 87.244,
  84.374, 82.831, 80.019, 80.460, 79.174, 79.048
])

def spectra_to_xyz(reflectance, start_wl=380):
    """
    reflectance: array-like of length L, values 0-1, step 10 nm starting at start_wl
    Returns [X, Y, Z] (raw, not scaled to Y=100)
    """
    X = Y = Z = 0.0
    # We assume reflectance length matches the number of wavelength steps in D50/CMF arrays
    # If not, we will ignore extra or missing values.
    L = len(reflectance)
    steps = min(L, len(D50))
    for i in range(steps):
        R = reflectance[i]
        d = D50[i]
        X += R * d * CMF_X[i]
        Y += R * d * CMF_Y[i]
        Z += R * d * CMF_Z[i]
    return np.array([X, Y, Z])

def compute_white_point():
    """XYZ of perfect reflecting diffuser (reflectance=1) under D50"""
    return spectra_to_xyz(np.ones(len(D50)))

WHITE_POINT = compute_white_point()
# Normalize so that Y=100? In Lab, the white point is the reference white.
# The CIE Lab formula uses the white point as reference.
# We'll keep WHITE_POINT as is and use it in xyz_to_lab.

def xyz_to_lab(xyz):
    x, y, z = xyz
    xr, yr, zr = WHITE_POINT
    # Avoid division by zero
    if xr == 0 or yr == 0 or zr == 0:
        raise ValueError("White point has zero component")
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
    return np.array([L, a, b])

def spectrum_to_lab(spectrum):
    """Convert reflectance spectrum to Lab"""
    xyz = spectra_to_xyz(spectrum)
    return xyz_to_lab(xyz)

# Load data
with open('../frontend/data/cae-input/profiles-mk.json') as f:
    data = json.load(f)

# Filter WCRW profiles
wcrw_profiles = [p for p in data['profiles'] if p['substrate'] == 'WCRW']
print(f"Found {len(wcrw_profiles)} WCRW profiles")
print("Profiles:")
for p in wcrw_profiles:
    print(f"  {p['full_name']}")

# For each profile, compute a*b for each patch and analyze
all_angles = []
all_chromas = []
for profile in wcrw_profiles:
    name = profile['full_name']
    a_vals = []
    b_vals = []
    L_vals = []
    for patch in profile['patches']:
        lab = spectrum_to_lab(patch['spectrum'])
        L_vals.append(lab[0])
        a_vals.append(lab[1])
        b_vals.append(lab[2])
    a_vals = np.array(a_vals)
    b_vals = np.array(b_vals)
    L_vals = np.array(L_vals)
    print(f"\n=== {name} ===")
    print(f"  Substrate: {profile['substrate']}, Ink mode: {profile['ink_mode']}")
    print(f"  Number of patches: {len(a_vals)}")
    print(f"  L range: [{np.min(L_vals):.2f}, {np.max(L_vals):.2f}] (mean={np.mean(L_vals):.2f})")
    print(f"  a range: [{np.min(a_vals):.2f}, {np.max(a_vals):.2f}] (mean={np.mean(a_vals):.2f})")
    print(f"  b range: [{np.min(b_vals):.2f}, {np.max(b_vals):.2f}] (mean={np.mean(b_vals):.2f})")
    # Paper spectrum
    paper_lab = spectrum_to_lab(profile['paper_spectrum'])
    print(f"  Paper Lab: L={paper_lab[0]:.2f}, a={paper_lab[1]:.2f}, b={paper_lab[2]:.2f}")
    # Compute chroma and hue
    chroma = np.sqrt(a_vals**2 + b_vals**2)
    hue = np.degrees(np.arctan2(b_vals, a_vals))  # range [-180, 180)
    hue = (hue + 360) % 360  # [0, 360)
    print(f"  Chroma range: [{np.min(chroma):.2f}, {np.max(chroma):.2f}] (mean={np.mean(chroma):.2f})")
    # Bin hue into 1-degree bins
    n_bins = 360
    bin_width = 360.0 / n_bins
    r_max = np.zeros(n_bins)  # max chroma per bin
    count = np.zeros(n_bins, dtype=int)
    for h, c in zip(hue, chroma):
        bin_idx = int(h // bin_width)
        if bin_idx == n_bins:  # hue == 360.0 due to rounding
            bin_idx = 0
        if c > r_max[bin_idx]:
            r_max[bin_idx] = c
        count[bin_idx] += 1
    # Find local maxima in r_max (circular)
    local_max_indices = []
    for i in range(n_bins):
        left = (i - 1) % n_bins
        right = (i + 1) % n_bins
        if r_max[i] > r_max[left] and r_max[i] > r_max[right]:
            local_max_indices.append(i)
    print(f"  Number of local maxima in chroma vs hue (1-degree bins): {len(local_max_indices)}")
    # Get the angles and chroma values
    angles = []
    chromas = []
    for idx in local_max_indices:
        angle = idx * bin_width + bin_width / 2.0  # center of bin
        angles.append(angle)
        chromas.append(r_max[idx])
    # Sort by angle for readability
    sorted_pairs = sorted(zip(angles, chromas))
    print(f"  Local maxima (angle, chroma):")
    for angle, chroma in sorted_pairs:
        print(f"    {angle:.1f}°: {chroma:.2f}")
        all_angles.append(angle)
        all_chromas.append(chroma)
    # Also compute convex hull of a*b points using scipy if available, else skip
    try:
        from scipy.spatial import ConvexHull
        points = np.column_stack((a_vals, b_vals))
        hull = ConvexHull(points)
        print(f"  Convex hull vertices: {len(hull.vertices)}")
        hull_angles = np.degrees(np.arctan2(points[hull.vertices, 1], points[hull.vertices, 0])) % 360
        hull_chroma = np.sqrt(points[hull.vertices, 0]**2 + points[hull.vertices, 1]**2)
        hull_sorted = sorted(zip(hull_angles, hull_chroma))
        print(f"  Hull vertices (angle, chroma):")
        for angle, chroma in hull_sorted:
            print(f"    {angle:.1f}°: {chroma:.2f}")
    except ImportError:
        print("  scipy not available, skipping convex hull")
print("\n=== Summary across all WCRW profiles ===")
if all_angles:
    # Convert angles to radians for averaging (vector average)
    sin_sum = np.sum(np.sin(np.radians(all_angles)))
    cos_sum = np.sum(np.cos(np.radians(all_angles)))
    mean_angle = np.degrees(np.arctan2(sin_sum, cos_sum)) % 360
    mean_chroma = np.mean(all_chromas)
    print(f"Mean angle of local maxima (vector average): {mean_angle:.1f}°")
    print(f"Mean chroma at those angles: {mean_chroma:.2f}")
    # Also compute median angle (circular median) by converting to complex numbers
    # We'll just print the list of unique angles rounded to nearest degree
    unique_angles = np.round(all_angles).astype(int)
    unique_angles = np.unique(unique_angles)
    print(f"Unique angles (rounded to degree): {unique_angles}")
    print(f"Number of unique angles: {len(unique_angles)}")
import json
import numpy as np
import os

# We'll define the constants by copying from the file and ensuring length 36.
# Let's first check by reading the file and extracting the arrays.
def extract_array(line):
    # Given a line like "const CMF_X = [ ... ];", extract the array inside [...]
    start = line.find('[')
    end = line.rfind(']')
    if start == -1 or end == -1:
        return []
    inner = line[start+1:end]
    # Split by commas, strip whitespace, filter empty
    parts = [p.strip() for p in inner.split(',') if p.strip()!='']
    # Convert to float
    return [float(p) for p in parts]

# Read the file
with open('../../frontend/src/lib/colormath.ts', 'r') as f:
    lines = f.readlines()

CMF_X = None
CMF_Y = None
CMF_Z = None
D50 = None
for line in lines:
    if line.strip().startswith('const CMF_X = ['):
        CMF_X = extract_array(line)
    elif line.strip().startswith('const CMF_Y = ['):
        CMF_Y = extract_array(line)
    elif line.strip().startswith('const CMF_Z = ['):
        CMF_Z = extract_array(line)
    elif line.strip().startswith('const D50 = ['):
        D50 = extract_array(line)

# Convert to numpy arrays
CMF_X = np.array(CMF_X)
CMF_Y = np.array(CMF_Y)
CMF_Z = np.array(CMF_Z)
D50 = np.array(D50)

print(f"Lengths: CMF_X={len(CMF_X)}, CMF_Y={len(CMF_Y)}, CMF_Z={len(CMF_Z)}, D50={len(D50)}")

# Compute K_NORM = sum(D50[i] * CMF_Y[i])
K_NORM = np.sum(D50 * CMF_Y)
# Scale factor to get XYZ where Y=100 for perfect white
S = 100.0 / K_NORM

def spectra_to_xyz(reflectance, start_wl=380):
    """
    reflectance: array-like of length L, values 0-1, step 10 nm starting at start_wl
    Returns [X, Y, Z] scaled such that perfect reflector gives Y=100
    """
    X = Y = Z = 0.0
    L = len(reflectance)
    steps = min(L, len(D50))
    for i in range(steps):
        R = reflectance[i]
        d = D50[i]
        X += R * d * CMF_X[i]
        Y += R * d * CMF_Y[i]
        Z += R * d * CMF_Z[i]
    X *= S
    Y *= S
    Z *= S
    return np.array([X, Y, Z])

def compute_white_point():
    """XYZ of perfect reflecting diffuser (reflectance=1) under D50, scaled to Y=100"""
    return spectra_to_xyz(np.ones(len(D50)))

WHITE_POINT = compute_white_point()
# Sanity check: WHITE_POINT[1] should be very close to 100.0
print(f"White point XYZ: {WHITE_POINT} (Y should be ~100)")

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
with open('../../frontend/data/cae-input/profiles-mk.json') as f:
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
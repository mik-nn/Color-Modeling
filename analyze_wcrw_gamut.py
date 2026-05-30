import json
import numpy as np
import re

# Read the colormath.ts file
with open('frontend/src/lib/colormath.ts', 'r') as f:
    content = f.read()

# Function to extract array from a pattern like "const CMF_X = [ ... ];"
def extract_array(name):
    pattern = rf'const {name}\s*=\s*\[([^\]]*)\]'
    match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
    if not match:
        raise ValueError(f"Could not find array {name}")
    inner = match.group(1)
    # Split by commas, strip whitespace, filter empty strings and comments
    parts = []
    for part in inner.split(','):
        part = part.strip()
        # Remove inline comments (if any)
        if '//' in part:
            part = part.split('//')[0].strip()
        if part == '':
            continue
        try:
            parts.append(float(part))
        except ValueError:
            # If conversion fails, skip (should not happen)
            pass
    return np.array(parts)

try:
    CMF_X = extract_array('CMF_X')
    CMF_Y = extract_array('CMF_Y')
    CMF_Z = extract_array('CMF_Z')
    D50 = extract_array('D50')
except Exception as e:
    print(f"Error extracting arrays: {e}")
    # Fallback to hardcoded lengths (we know they should be 36)
    # We'll try to read line by line as before but more carefully.
    lines = content.splitlines()
    CMF_X = []
    CMF_Y = []
    CMF_Z = []
    D50 = []
    in_array = False
    current_name = None
    current_array = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('const CMF_X = ['):
            current_name = 'CMF_X'
            current_array = CMF_X
            in_array = True
            # Extract the part after '['
            after_bracket = line.split('[', 1)[1]
            # We'll collect lines until we find a closing ']'
            # For simplicity, we assume the array is on one line.
            # If not, we need a more complex parser. Let's assume one line for now.
            # Actually, from the file we saw, each array is on multiple lines.
            # We'll change approach: read until we find a line that ends with '];'
            # We'll do a simple state machine.
            # Let's instead use a different method: find the line index and then collect until we see the closing bracket.
            pass
        # Given time, we'll assume the arrays are on one line. But they are not.
        # Let's use the regex with DOTALL to match across lines.
        # We already did that above. If it failed, we'll print the content around the area.
        pass

# Since the regex didn't work, let's try a different approach: find the start and end indices of the array by scanning for the pattern.
# We'll do for each array.

def extract_array_bruteforce(name):
    # Find the start: "const name = ["
    pattern = re.escape(f'const {name} = [')
    match = re.search(pattern, content)
    if not match:
        raise ValueError(f"Could not find start of array {name}")
    start_pos = match.end()  # position after the '['
    # Now we need to find the matching closing ']'
    # We'll scan forward, keeping track of bracket depth.
    depth = 1
    i = start_pos
    while i < len(content):
        ch = content[i]
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                end_pos = i
                break
        i += 1
    else:
        raise ValueError(f"Could not find matching closing bracket for array {name}")
    inner = content[start_pos:end_pos]
    # Now split inner by commas, but we need to ignore commas inside comments? 
    # Since there are no comments inside the array (hopefully), we can split by commas.
    # However, there might be spaces and newlines.
    # We'll split by commas and then strip whitespace and try to convert to float.
    parts = []
    for token in inner.split(','):
        token = token.strip()
        # Remove any trailing comments (if any)
        if '//' in token:
            token = token.split('//')[0].strip()
        if token == '':
            continue
        try:
            parts.append(float(token))
        except ValueError:
            # If conversion fails, skip (should not happen)
            pass
    return np.array(parts)

# Now try to extract with brute force
CMF_X = extract_array_bruteforce('CMF_X')
CMF_Y = extract_array_bruteforce('CMF_Y')
CMF_Z = extract_array_bruteforce('CMF_Z')
D50 = extract_array_bruteforce('D50')

print(f"Lengths: CMF_X={len(CMF_X)}, CMF_Y={len(CMF_Y)}, CMF_Z={len(CMF_Z)}, D50={len(D50)}")
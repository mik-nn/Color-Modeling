/**
 * Very small ICC tag directory scanner (debug-only).
 *
 * Goal: locate where in a binary .icc/.icm file there are embedded strings
 * like "@data" / "CxF".
 *
 * NOTE: This is NOT a full ICC parser. It only reads the ICC header + tag table
 * and then tries to decode tag values as text.
 */

export type IccTagHit = {
  tagSignature: string; // e.g. 'desc'
  offset: number; // absolute offset in file
  size: number; // bytes
  decodedText?: string; // best-effort decode
  matched: {
    hasAtData: boolean;
    hasCxF: boolean;
    hasAtHeader: boolean;
  };
};

export type IccScanResult = {
  hits: IccTagHit[];
  summary: {
    totalTags: number;
    scannedTags: number;
    textDecodes: number;
  };
};

/**
 * ICC header is 128 bytes.
 * Tag table begins at byte 128.
 *
 * Header fields (big-endian):
 * - tag count at offset 128 + 0 (4 bytes)
 * - each tag record: signature(4), offset(4), size(4) => 12 bytes per tag
 */
const ICC_HEADER_SIZE = 128;
const TAG_RECORD_SIZE = 12;

function readU32BE(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

function decodeAsciiish(bytes: Uint8Array): string | undefined {
  // Best-effort decode to UTF-8; if it fails, return undefined.
  // Many ICC blobs use ASCII-ish; some might use UTF-16BE.
  try {
    const td = new TextDecoder('utf-8', { fatal: false });
    const s = td.decode(bytes);
    // Avoid returning huge junk: only keep if it has any marker characters.
    if (/[A-Za-z@]/.test(s)) return s;
  } catch {
    // ignore
  }

  // Try UTF-16BE
  try {
    // Convert UTF-16BE bytes to code units
    if (bytes.length % 2 !== 0) return undefined;
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    // Need to swap endianness (DataView uses platform endianness)
    const swapped = new Uint16Array(u16.length);
    for (let i = 0; i < u16.length; i++) swapped[i] = ((u16[i] & 0xff) << 8) | (u16[i] >> 8);
    const td2 = new TextDecoder('utf-16le', { fatal: false }); // after swap it becomes LE
    const u8 = new Uint8Array(swapped.buffer);
    const s2 = td2.decode(u8);
    if (/[A-Za-z@]/.test(s2)) return s2;
  } catch {
    // ignore
  }

  return undefined;
}

function sliceSafe(bytes: Uint8Array, offset: number, size: number): Uint8Array {
  const start = Math.max(0, offset);
  const end = Math.min(bytes.byteLength, offset + size);
  if (end <= start) return new Uint8Array();
  return bytes.slice(start, end);
}

export function scanIccForCxFMarkers(buffer: ArrayBuffer): IccScanResult {
  const view = new DataView(buffer);
  const totalSize = buffer.byteLength;

  // Need at least header + tag count
  if (totalSize < ICC_HEADER_SIZE + 4) {
    return {
      hits: [],
      summary: { totalTags: 0, scannedTags: 0, textDecodes: 0 },
    };
  }

  // Read tag count (big endian) at 128
  // Some ICC files store tagCount in header extension; but commonly it is at byte 128.
  const tagCount = readU32BE(view, ICC_HEADER_SIZE);
  const tagsStart = ICC_HEADER_SIZE + 4;

  if (tagsStart + tagCount * TAG_RECORD_SIZE > totalSize) {
    // Corrupt/unexpected
    return {
      hits: [],
      summary: { totalTags: tagCount, scannedTags: 0, textDecodes: 0 },
    };
  }

  const bytes = new Uint8Array(buffer);
  const hits: IccTagHit[] = [];
  let scannedTags = 0;
  let textDecodes = 0;

  for (let i = 0; i < tagCount; i++) {
    const recOffset = tagsStart + i * TAG_RECORD_SIZE;

    const sigBytes = sliceSafe(bytes, recOffset, 4);
    const tagSignature = String.fromCharCode(...sigBytes);

    const valueOffset = readU32BE(view, recOffset + 4);
    const size = readU32BE(view, recOffset + 8);

    if (!tagSignature || size === 0) continue;

    scannedTags++;

    const valueBytes = sliceSafe(bytes, valueOffset, size);
    if (valueBytes.byteLength === 0) continue;

    const decodedText = decodeAsciiish(valueBytes);
    if (decodedText) textDecodes++;

    const hasAtData = decodedText ? decodedText.includes('@data') : false;
    const hasCxF = decodedText ? decodedText.toLowerCase().includes('cxf') : false;
    const hasAtHeader = decodedText ? decodedText.includes('@header') : false;

    if (hasAtData || hasCxF || hasAtHeader) {
      hits.push({
        tagSignature,
        offset: valueOffset,
        size,
        decodedText,
        matched: { hasAtData, hasCxF, hasAtHeader },
      });
    }
  }

  return {
    hits,
    summary: { totalTags: tagCount, scannedTags, textDecodes },
  };
}

/**
 * Extract a best-effort CxF-ish block from a decoded text.
 * Since we don't know the exact encoding boundaries, keep it heuristic.
 */
export function extractCxFishFromText(text: string): string | undefined {
  const lower = text.toLowerCase();
  const idxData = lower.indexOf('@data');
  if (idxData === -1) return undefined;

  // Try to cut until the next '@' marker (header/footer/whatever)
  const nextAt = text.indexOf('@', idxData + 1);
  // If nextAt is too early, fallback to end
  const end = nextAt > idxData + 10 ? nextAt : Math.min(text.length, idxData + 200000);

  const slice = text.slice(idxData, end);
  if (slice.trim().length === 0) return undefined;
  return slice;
}

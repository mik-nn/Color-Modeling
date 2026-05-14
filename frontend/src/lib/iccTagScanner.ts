import { inflate } from 'pako';
import type { IccTagHit, IccScanResult } from './types'

/**
 * Very small ICC tag directory scanner (debug-only).
 *
 * Goal: locate where in a binary .icc/.icm file there are embedded strings
 * like "@data" / "CxF".
 *
 * CxF Embedding Specifications:
 * - ICC.1 v4 (ISO 15076-1:2022) supports private tags for CxF
 * - iccMAX (ICC.2) supports CxF format for spectral measurement data
 * - CxF/X3 (ISO 17972-3) is the standard for output target data
 * - CxF data can be embedded in: desc, dmnd, dmdd, cprt, and private tags
 * - Tag signatures are 4-char ASCII codes (e.g., 'CxF ', 'spec', 'xrdb')
 * - ZXML (0x5a584d4c) - ZIP-compressed XML format used by X-Rite for CxF tags
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

    const content = decodedText || '';
    const hasAtData = content.includes('@data');
    const hasCxF = content.toLowerCase().includes('cxf');
    const hasAtHeader = content.includes('@header');
    // Also look for spectral measurement patterns
    const hasSpectral = /\b\d{3}\s+0\.\d+/.test(content); // wavelength reflectance pattern

    if (hasAtData || hasCxF || hasAtHeader || hasSpectral) {
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
 * Find the ZXML tag in an ICC profile and return the decompressed XML string.
 * ZXML = X-Rite private tag type for zlib-compressed CxF3 XML.
 * Layout: 4 bytes tag type ('ZXML') + 4 bytes reserved + 4 bytes unknown + zlib stream.
 */
export function extractZxmlCxfXml(buffer: ArrayBuffer): string | null {
  const view = new DataView(buffer);
  const totalSize = buffer.byteLength;

  if (totalSize < ICC_HEADER_SIZE + 4) return null;

  const tagCount = readU32BE(view, ICC_HEADER_SIZE);
  const tagsStart = ICC_HEADER_SIZE + 4;

  if (tagsStart + tagCount * TAG_RECORD_SIZE > totalSize) return null;

  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < tagCount; i++) {
    const recOffset = tagsStart + i * TAG_RECORD_SIZE;
    const valueOffset = readU32BE(view, recOffset + 4);
    const size = readU32BE(view, recOffset + 8);

    if (size < 12 || valueOffset + size > totalSize) continue;

    // ZXML is a data-type signature at the start of tag content (not in tag directory)
    const dataType =
      String.fromCharCode(bytes[valueOffset]) +
      String.fromCharCode(bytes[valueOffset + 1]) +
      String.fromCharCode(bytes[valueOffset + 2]) +
      String.fromCharCode(bytes[valueOffset + 3]);

    if (dataType !== 'ZXML') continue;

    // ZXML layout: 4 bytes data-type + 4 bytes reserved + 4 bytes unknown + zlib stream
    const compressedData = bytes.slice(valueOffset + 12, valueOffset + size);

    try {
      const decompressed = inflate(compressedData);
      return new TextDecoder('utf-8').decode(decompressed);
    } catch {
      return null;
    }
  }

  return null;
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

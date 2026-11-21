// Dependency-free source-map consumer for the breakpoint debugger's eval seam.
//
// Code evaluated through a Function/AsyncFunction constructor (Vite's SSR
// ModuleRunner, vm.compileFunction) never passes the require loader, so the
// debugger meets it as a finished body with a trailing inline source map. To
// bind breakpoints on the ORIGINAL source and report paused frames in original
// lines, that map must be decoded in-guest. This module is the whole consumer:
// base64 → UTF-8, VLQ mappings, and a LINE-level mapper (the debugger works in
// whole lines — probes are woven per statement line, columns are not reported).
//
// Hand-rolled on purpose: the debugger ships in a lazy import() chunk that must
// stay dependency-free (see the breakpoint-debugger gotcha in AGENTS.md), and a
// general source-map library would be two orders of magnitude more code than the
// line remap needs. Only standard v3 maps are understood; anything malformed
// throws and the caller self-heals to the un-remapped body.

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Int16Array(128).fill(-1);
for (let i = 0; i < B64_CHARS.length; i++) B64_VALUE[B64_CHARS.charCodeAt(i)] = i;

/** Decode a base64 string to a UTF-8 string. Throws on invalid input. */
export function decodeBase64Utf8(input) {
  const s = String(input).replace(/=+$/, "");
  const bytes = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_VALUE[c] : -1;
    if (v < 0) throw new Error("invalid base64 character");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  // UTF-8 → code points (the map JSON can carry non-ASCII sourcesContent).
  // Chunked: a spread of 100k+ code points would blow V8's argument limit on a
  // big module's map, and the seam must not degrade there.
  let out = "";
  let chunk = [];
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    chunk.push(cp);
    if (chunk.length >= 8192) {
      out += String.fromCodePoint(...chunk);
      chunk = [];
    }
  }
  if (chunk.length) out += String.fromCodePoint(...chunk);
  return out;
}

/** Decode one VLQ segment into its signed integer fields. Throws on bad digits. */
export function decodeVlq(segment) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    const digit = c < 128 ? B64_VALUE[c] : -1;
    if (digit < 0) throw new Error("invalid VLQ digit");
    value |= (digit & 0x1f) << shift;
    if (digit & 0x20) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>>= 1;
    out.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  return out;
}

/**
 * Decode a v3 `mappings` string into per-generated-line segment lists.
 * Lines are 0-based; each mapped segment is [genCol, sourceIndex, srcLine0, srcCol]
 * (deltas resolved), each unmapped segment is [genCol].
 */
export function decodeMappings(mappings) {
  const lines = [];
  let sourceIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineStr of String(mappings).split(";")) {
    const segments = [];
    let genCol = 0;
    if (lineStr) {
      for (const seg of lineStr.split(",")) {
        if (!seg) continue;
        const fields = decodeVlq(seg);
        genCol += fields[0];
        if (fields.length >= 4) {
          sourceIndex += fields[1];
          srcLine += fields[2];
          srcCol += fields[3];
          segments.push([genCol, sourceIndex, srcLine, srcCol]);
        } else {
          segments.push([genCol]); // generated-only (no source) segment
        }
      }
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * Build a line-level mapper over a decoded v3 map, or null when the map is not a
 * usable v3 map. Both directions are 1-BASED (the debugger's line convention):
 *
 *   toSource(genLine)             original line for a generated line, or null
 *   toGenerated(srcLine)          EARLIEST generated line mapping to srcLine, or null
 *   toGeneratedAtOrAfter(srcLine) earliest generated line mapping to a source
 *                                 line >= srcLine, or null (slide-forward bind)
 *
 * The eval seam's maps are single-source (Vite's ssrTransform sets
 * sources=[basename]); for multi-source maps the first mapped segment of a line
 * wins, which is the best a whole-line remap can do without columns.
 */
export function createLineMapper(map) {
  if (!map || map.version !== 3 || typeof map.mappings !== "string") return null;
  const lines = decodeMappings(map.mappings);
  // Inverse index: original line -> earliest generated line.
  const inverse = new Map();
  for (let g = 0; g < lines.length; g++) {
    for (const seg of lines[g]) {
      if (seg.length < 4) continue;
      const prev = inverse.get(seg[2]);
      if (prev == null || g < prev) inverse.set(seg[2], g);
    }
  }
  const sortedSources = [...inverse.keys()].sort((a, b) => a - b);
  return {
    toSource(genLine1) {
      const segs = lines[genLine1 - 1];
      if (!segs) return null;
      for (const seg of segs) if (seg.length >= 4) return seg[2] + 1;
      return null;
    },
    toGenerated(srcLine1) {
      const g = inverse.get(srcLine1 - 1);
      return g == null ? null : g + 1;
    },
    toGeneratedAtOrAfter(srcLine1) {
      const target = srcLine1 - 1;
      let lo = 0;
      let hi = sortedSources.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedSources[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      if (lo >= sortedSources.length) return null;
      return inverse.get(sortedSources[lo]) + 1;
    },
  };
}

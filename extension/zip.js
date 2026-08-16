// zip.js — the smallest ZIP reader/writer that can round-trip a .docx.
//
// A .docx is a ZIP holding a dozen XML parts. To tailor one in place we have to
// open it, replace exactly one part (`word/document.xml`), and write the rest
// back BYTE FOR BYTE. Everything the user cares about — fonts, margins, styles,
// numbering, headers, the theme — lives in those other parts, and the whole
// point of editing in place rather than regenerating is that we never touch
// them.
//
// Why not a library: MV3 forbids remote code, so JSZip or fflate would have to
// be vendored into the repo and kept updated. Chrome ships DecompressionStream
// and CompressionStream with 'deflate-raw', which is precisely the codec ZIP
// uses, so the only thing actually missing is the container format — and that
// is the 150 lines below. No dependency, nothing to audit, nothing to update.
//
// Deliberately partial: no ZIP64, no encryption, no multi-disk. A Word document
// is a few hundred kilobytes and uses none of them. Anything that does is
// rejected loudly rather than half-read.
//
// Exposes window.JobCopilotZip = { read, write }.

(function () {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG  = 0x02014b50;
  const LOC_SIG  = 0x04034b50;

  // CRC-32, the checksum every ZIP entry carries. Word will refuse a document
  // whose CRC doesn't match its data, so this is not optional.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function deflateRaw(bytes) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * Read a ZIP into an ordered list of entries.
   *
   * Order is preserved and returned as-is because a .docx is not an unordered
   * bag: `[Content_Types].xml` is expected first, and some consumers are
   * fussier about that than the spec strictly requires. Writing the entries
   * back in the order they arrived costs nothing and removes the question.
   *
   * Returns [{ name, bytes }] with bytes already decompressed.
   */
  async function read(buffer) {
    const data = new Uint8Array(buffer);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // The EOCD sits at the very end, after a comment of unknown length. Scan
    // backwards for its signature; the comment is capped at 65535 bytes.
    let eocd = -1;
    const floor = Math.max(0, data.length - 65557);
    for (let i = data.length - 22; i >= floor; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory)");

    const count = view.getUint16(eocd + 10, true);
    let at = view.getUint32(eocd + 16, true);
    if (at === 0xffffffff || count === 0xffff) {
      throw new Error("ZIP64 archives are not supported");
    }

    const decoder = new TextDecoder();
    const entries = [];

    for (let n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== CEN_SIG) {
        throw new Error("corrupt zip: bad central directory entry");
      }
      const method   = view.getUint16(at + 10, true);
      const compSize = view.getUint32(at + 20, true);
      const nameLen  = view.getUint16(at + 28, true);
      const extraLen = view.getUint16(at + 30, true);
      const cmtLen   = view.getUint16(at + 32, true);
      const localAt  = view.getUint32(at + 42, true);
      const name     = decoder.decode(data.subarray(at + 46, at + 46 + nameLen));

      if (view.getUint32(localAt, true) !== LOC_SIG) {
        throw new Error(`corrupt zip: bad local header for ${name}`);
      }
      // The local header repeats the name and extra fields, and its extra
      // field length routinely differs from the central one — reading the
      // central directory's value here is the classic way to land mid-file.
      const lNameLen  = view.getUint16(localAt + 26, true);
      const lExtraLen = view.getUint16(localAt + 28, true);
      const from = localAt + 30 + lNameLen + lExtraLen;
      const raw  = data.subarray(from, from + compSize);

      let bytes;
      if (method === 0) bytes = raw.slice();
      else if (method === 8) bytes = await inflateRaw(raw);
      else throw new Error(`unsupported compression method ${method} for ${name}`);

      entries.push({ name, bytes });
      at += 46 + nameLen + extraLen + cmtLen;
    }

    return entries;
  }

  /**
   * Write entries back out as a ZIP.
   *
   * Everything is deflated except entries that don't shrink, which are stored.
   * Word does not care which, and it keeps a pathological XML part from growing
   * the file.
   */
  async function write(entries) {
    const encoder = new TextEncoder();
    const locals = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const bytes = entry.bytes;
      const deflated = await deflateRaw(bytes);
      const store = deflated.length >= bytes.length;
      const payload = store ? bytes : deflated;
      const method = store ? 0 : 8;
      const crc = crc32(bytes);

      const local = new Uint8Array(30 + name.length + payload.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, LOC_SIG, true);
      lv.setUint16(4, 20, true);              // version needed
      lv.setUint16(6, 0x0800, true);          // UTF-8 filenames
      lv.setUint16(8, method, true);
      lv.setUint16(10, 0, true);              // mod time — fixed, see below
      lv.setUint16(12, 0x21, true);           // mod date — 1980-01-01
      lv.setUint32(14, crc, true);
      lv.setUint32(18, payload.length, true);
      lv.setUint32(22, bytes.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      local.set(payload, 30 + name.length);
      locals.push(local);

      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, CEN_SIG, true);
      cv.setUint16(4, 20, true);              // version made by
      cv.setUint16(6, 20, true);              // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, payload.length, true);
      cv.setUint32(24, bytes.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);

      offset += local.length;
    }

    const cenSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, EOCD_SIG, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cenSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + cenSize + 22;
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of locals)  { out.set(b, at); at += b.length; }
    for (const b of central) { out.set(b, at); at += b.length; }
    out.set(eocd, at);
    return out;
  }

  // Timestamps are fixed at 1980-01-01 rather than "now" on purpose: it makes
  // the output byte-identical for identical input, so a re-render of the same
  // packet produces the same file and a diff of two tailorings shows only what
  // actually changed.

  window.JobCopilotZip = { read, write, crc32 };
})();

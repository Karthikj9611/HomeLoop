// Moves the MP4/MOV "moov" atom in front of "mdat" (what `ffmpeg -movflags +faststart` does), without re-encoding.
// Phone / screen recordings put moov at the END, so browsers must fetch the tail before playing = slow start.
// Pure JS, no dependencies. Returns the SAME buffer when nothing needs doing (webm/ogg, already faststart, unparseable).
const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl', 'edts']);

function bump(buf, start, end, delta) {
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size < 8 || pos + size > end) return false;
    if (CONTAINERS.has(type)) {
      if (!bump(buf, pos + 8, pos + size, delta)) return false;
    } else if (type === 'stco') {
      const n = buf.readUInt32BE(pos + 12);
      for (let i = 0; i < n; i++) {
        const o = pos + 16 + i * 4;
        const v = buf.readUInt32BE(o) + delta;
        if (v > 0xFFFFFFFF) return false;
        buf.writeUInt32BE(v, o);
      }
    } else if (type === 'co64') {
      const n = buf.readUInt32BE(pos + 12);
      for (let i = 0; i < n; i++) {
        const o = pos + 16 + i * 8;
        buf.writeBigUInt64BE(buf.readBigUInt64BE(o) + BigInt(delta), o);
      }
    }
    pos += size;
  }
  return true;
}

function faststart(buf) {
  try {
    const atoms = [];
    let pos = 0;
    while (pos + 8 <= buf.length) {
      let size = buf.readUInt32BE(pos), hdr = 8;
      const type = buf.toString('latin1', pos + 4, pos + 8);
      if (size === 1) { if (pos + 16 > buf.length) return buf; size = Number(buf.readBigUInt64BE(pos + 8)); hdr = 16; }
      else if (size === 0) size = buf.length - pos;
      if (size < hdr || pos + size > buf.length) return buf;
      atoms.push({ type, pos, size });
      pos += size;
    }
    const mi = atoms.findIndex(a => a.type === 'moov');
    const di = atoms.findIndex(a => a.type === 'mdat');
    if (mi < 0 || di < 0 || mi < di) return buf;             // no moov / already at the front
    const moov = atoms[mi];
    const moovBuf = Buffer.from(buf.subarray(moov.pos, moov.pos + moov.size));
    if (!bump(moovBuf, 8, moovBuf.length, moov.size)) return buf;
    const parts = [];
    atoms.forEach((a, i) => {
      if (i === mi) return;
      if (i === di) parts.push(moovBuf);
      parts.push(buf.subarray(a.pos, a.pos + a.size));
    });
    const out = Buffer.concat(parts);
    return out.length === buf.length ? out : buf;
  } catch (e) { return buf; }
}
module.exports = { faststart, bump };

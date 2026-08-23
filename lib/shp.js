'use strict';

// 最小 shapefile 读取器（零依赖）：解析 .shp（几何）与 .dbf（属性）
// 支持：Point/PolyLine/Polygon（含 Z 变体）；DBF 字段类型 C/N/F/L/D/I/B
// 注意：CPTOND 坐标系为 WGS-84，编码 UTF-8

const fs = require('fs');

function parseDbf(file) {
  const buf = fs.readFileSync(file);
  const recordCount = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  const fields = [];
  let off = 32;
  while (off < headerLen) {
    if (buf[off] === 0x0d) break;
    const name = buf.toString('utf8', off, off + 11).replace(/\0.*$/, '').trim();
    const type = String.fromCharCode(buf[off + 11]);
    const len = buf[off + 16];
    const dec = buf[off + 17];
    fields.push({ name, type, len, dec });
    off += 32;
  }

  const records = [];
  let r = headerLen;
  for (let i = 0; i < recordCount; i++) {
    const rec = {};
    const recBuf = buf.subarray(r, r + recordLen);
    const deleted = recBuf[0] === 0x2a;
    let p = 1;
    for (const f of fields) {
      let v = null;
      const raw = recBuf.toString('utf8', p, p + f.len);
      switch (f.type) {
        case 'C':
          v = raw.trim();
          break;
        case 'N':
        case 'F': {
          const s = raw.trim();
          v = s === '' || s === '*' ? null : Number(s);
          break;
        }
        case 'L': {
          const c = String.fromCharCode(recBuf[p]);
          v = c === 'T' || c === 'Y';
          break;
        }
        case 'D': {
          const s = raw.trim();
          v = s || null;
          break;
        }
        case 'I':
          v = recBuf.readInt32LE(p);
          break;
        case 'B':
          v = recBuf.readDoubleLE(p);
          break;
        default:
          v = raw.trim();
      }
      rec[f.name] = v;
      p += f.len;
    }
    records.push({ deleted, attributes: rec });
    r += recordLen;
  }
  return { fields, records, recordCount };
}

function parseShp(file) {
  const buf = fs.readFileSync(file);
  const shapeType = buf.readInt32LE(32);
  const features = [];
  let off = 100;
  while (off + 8 <= buf.length) {
    const contentLen = buf.readInt32BE(off + 4); // 16-bit words
    const contentBytes = contentLen * 2;
    const content = buf.subarray(off + 8, off + 8 + contentBytes);
    features.push(parseGeometry(content));
    off += 8 + contentBytes;
  }
  return { shapeType, features };
}

function parseGeometry(content) {
  const type = content.readInt32LE(0);
  if (type === 0) return { type: 'null' };
  if (type === 1) return { type: 'point', coords: [content.readDoubleLE(4), content.readDoubleLE(12)] };
  if (type === 11) return { type: 'point', coords: [content.readDoubleLE(4), content.readDoubleLE(12)] };
  if (type === 8) return { type: 'multipoint' };
  if (type === 3 || type === 5 || type === 13 || type === 15) {
    const kind = type === 3 || type === 13 ? 'polyline' : 'polygon';
    const numParts = content.readInt32LE(36);
    const numPoints = content.readInt32LE(40);
    const parts = [];
    for (let i = 0; i < numParts; i++) parts.push(content.readInt32LE(44 + i * 4));
    const points = [];
    let po = 44 + numParts * 4;
    for (let i = 0; i < numPoints; i++) {
      points.push([content.readDoubleLE(po), content.readDoubleLE(po + 8)]);
      po += 16;
    }
    return { type: kind, parts, points, numParts, numPoints };
  }
  return { type: 'unknown', rawType: type };
}

module.exports = { parseDbf, parseShp };

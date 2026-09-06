const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Bencode Parser & Transmission Metadata Extractor
 * Parses .torrent files (Bencode dictionary) and magnet URIs to extract exact real payload names,
 * piece lengths, piece boundaries, file lists, and SHA-1 piece checksum information.
 */

function parseBencodeBuffer(buffer) {
  let offset = 0;

  function peekByte() {
    return buffer[offset];
  }

  function parseNext() {
    const char = String.fromCharCode(peekByte());
    if (char === 'i') {
      offset++;
      let end = buffer.indexOf(101, offset); // 'e'
      if (end === -1) throw new Error('Invalid Bencode integer');
      const str = buffer.toString('ascii', offset, end);
      offset = end + 1;
      return parseInt(str, 10);
    } else if (char === 'l') {
      offset++;
      const list = [];
      while (String.fromCharCode(peekByte()) !== 'e') {
        list.push(parseNext());
      }
      offset++;
      return list;
    } else if (char === 'd') {
      offset++;
      const dict = {};
      while (String.fromCharCode(peekByte()) !== 'e') {
        const key = parseString();
        dict[key] = parseNext();
      }
      offset++;
      return dict;
    } else if (char >= '0' && char <= '9') {
      return parseString();
    } else {
      throw new Error(`Invalid Bencode token: ${char} at offset ${offset}`);
    }
  }

  function parseString() {
    let colon = buffer.indexOf(58, offset); // ':'
    if (colon === -1) throw new Error('Invalid Bencode string length');
    const lenStr = buffer.toString('ascii', offset, colon);
    const len = parseInt(lenStr, 10);
    offset = colon + 1;
    const strBuffer = buffer.slice(offset, offset + len);
    offset += len;
    return strBuffer.toString('utf8');
  }

  return parseNext();
}

function extractRawInfoBuffer(buffer) {
  const infoKey = Buffer.from('4:info');
  const idx = buffer.indexOf(infoKey);
  if (idx === -1) return null;
  const start = idx + infoKey.length;
  let offset = start;
  let depth = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    if (byte === 100 || byte === 108) { // 'd' or 'l'
      depth++;
      offset++;
    } else if (byte === 101) { // 'e'
      depth--;
      offset++;
      if (depth === 0) {
        return buffer.subarray(start, offset);
      }
    } else if (byte === 105) { // 'i'
      offset++;
      const end = buffer.indexOf(101, offset);
      if (end === -1) break;
      offset = end + 1;
    } else if (byte >= 48 && byte <= 57) { // string length
      const colon = buffer.indexOf(58, offset);
      if (colon === -1) break;
      const len = parseInt(buffer.toString('ascii', offset, colon), 10);
      offset = colon + 1 + len;
    } else {
      break;
    }
  }
  return null;
}

function parseTorrentMetadata(filePathOrBuffer, magnetUri = null) {
  try {
    let buffer = null;
    if (Buffer.isBuffer(filePathOrBuffer)) {
      buffer = filePathOrBuffer;
    } else if (typeof filePathOrBuffer === 'string' && fs.existsSync(filePathOrBuffer)) {
      buffer = fs.readFileSync(filePathOrBuffer);
    }

    if (buffer) {
      let infoHash = null;
      try {
        const rawInfo = extractRawInfoBuffer(buffer);
        if (rawInfo) {
          infoHash = crypto.createHash('sha1').update(rawInfo).digest('hex');
        }
      } catch (e) {}

      const decoded = parseBencodeBuffer(buffer);
      const info = decoded.info || decoded;
      const torrentName = info.name || 'Torrent_Payload';
      const pieceLength = info['piece length'] || 524288;
      
      let totalLength = 0;
      let filesList = [];
      let isMultiFile = false;
      let currentByteOffset = 0;

      if (Array.isArray(info.files) && info.files.length > 0) {
        isMultiFile = true;
        info.files.forEach((f, idx) => {
          const fileLen = f.length || 0;
          const relativePath = Array.isArray(f.path) ? f.path.join('/') : (f.path || f.name || torrentName);
          
          const startByte = currentByteOffset;
          const endByte = currentByteOffset + fileLen - 1;
          const startPiece = Math.floor(startByte / pieceLength);
          const endPiece = Math.floor(endByte / pieceLength);

          currentByteOffset += fileLen;
          totalLength += fileLen;

          filesList.push({
            index: idx,
            name: path.basename(relativePath),
            path: relativePath,
            length: fileLen,
            startPiece: startPiece,
            endPiece: endPiece
          });
        });
      } else {
        totalLength = info.length || 0;
        filesList.push({
          index: 0,
          name: torrentName,
          path: torrentName,
          length: totalLength,
          startPiece: 0,
          endPiece: Math.max(0, Math.floor(totalLength / pieceLength))
        });
      }

      const numPieces = Math.ceil(totalLength / pieceLength);

      return {
        infoHash: infoHash,
        name: torrentName,
        length: totalLength,
        pieceLength: pieceLength,
        numPieces: numPieces,
        isMultiFile: isMultiFile,
        files: filesList,
        source: typeof filePathOrBuffer === 'string' ? path.basename(filePathOrBuffer) : torrentName
      };
    }
  } catch (err) {
    console.warn('Error parsing Bencode torrent buffer:', err.message);
  }

  // Magnet URI Fallback Parser
  let magnetName = 'Torrent.Payload';
  let magnetHash = null;
  const magnetStr = magnetUri || (typeof filePathOrBuffer === 'string' ? filePathOrBuffer : '');
  if (magnetStr) {
    const dnMatch = magnetStr.match(/dn=([^&]+)/);
    if (dnMatch) {
      try { magnetName = decodeURIComponent(dnMatch[1]); } catch (e) {}
    }
    const xtMatch = magnetStr.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    if (xtMatch) {
      magnetHash = xtMatch[1].toLowerCase();
    }
  }

  return {
    infoHash: magnetHash,
    name: magnetName,
    length: 0,
    pieceLength: 524288,
    numPieces: 0,
    isMultiFile: false,
    files: [{ index: 0, name: magnetName, path: magnetName, length: 0, startPiece: 0, endPiece: 0 }],
    source: magnetUri || 'Magnet Link'
  };
}

module.exports = {
  parseBencodeBuffer,
  parseTorrentMetadata
};

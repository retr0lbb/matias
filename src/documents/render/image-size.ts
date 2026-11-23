export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// JPEG start-of-frame markers carry the image size. C4 (DHT), C8 (JPG) and
// CC (DAC) share the range but are not frames.
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function pngSize(data: Buffer): ImageSize | null {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
  if (data.length < 24 || PNG_SIGNATURE.some((byte, i) => data[i] !== byte)) {
    return null;
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function jpegSize(data: Buffer): ImageSize | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 9 <= data.length) {
    if (data[offset] !== 0xff) {
      return null;
    }
    const marker = data[offset + 1];
    if (marker === 0xff) {
      // Fill byte before a marker.
      offset += 1;
      continue;
    }
    if (isStartOfFrame(marker)) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }

  return null;
}

/** Pixel size of a PNG or JPEG, read from its header; null when unreadable. */
export function readImageSize(data: Buffer): ImageSize | null {
  const size = pngSize(data) ?? jpegSize(data);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

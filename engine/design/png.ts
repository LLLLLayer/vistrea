import { inflateSync } from "node:zlib";

import { DataError } from "../../data/api/index.js";

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, four bytes per pixel, row-major from the top-left corner. */
  readonly pixels: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAXIMUM_DIMENSION = 16_384;

/**
 * Decodes the PNG subset every supported capture and design pipeline emits:
 * eight-bit greyscale, RGB, or RGBA, non-interlaced, with all five scanline
 * filters. Anything else fails closed as `unsupported` so pixel comparison
 * never guesses about visual truth.
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  if (bytes.length < PNG_SIGNATURE.length + 12) {
    throw new DataError("invalid_argument", "The PNG is truncated.");
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new DataError("invalid_argument", "The bytes are not a PNG image.");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let sawEnd = false;

  while (offset + 8 <= bytes.length && !sawEnd) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    const dataStart = offset + 8;
    if (length > bytes.length - dataStart - 4) {
      throw new DataError("invalid_argument", "The PNG is truncated.");
    }
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9] as number;
      const interlace = bytes[dataStart + 12];
      if (
        width < 1 ||
        height < 1 ||
        width > MAXIMUM_DIMENSION ||
        height > MAXIMUM_DIMENSION
      ) {
        throw new DataError("invalid_argument", "The PNG dimensions are unsupported.");
      }
      if (bitDepth !== 8 || ![0, 2, 6].includes(colorType) || interlace !== 0) {
        throw new DataError(
          "unsupported",
          "Pixel comparison supports eight-bit greyscale, RGB, or RGBA non-interlaced PNGs.",
        );
      }
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      sawEnd = true;
    }
    offset = dataStart + length + 4;
  }
  if (colorType < 0 || idat.length === 0 || !sawEnd) {
    throw new DataError("invalid_argument", "The PNG is missing required chunks.");
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const merged = Buffer.concat(idat.map((chunk) => Buffer.from(chunk)));
  let raw: Buffer;
  try {
    raw = inflateSync(merged, { maxOutputLength: (channels * width + 1) * height });
  } catch {
    throw new DataError("invalid_argument", "The PNG image data does not inflate.");
  }
  const stride = channels * width;
  if (raw.length !== (stride + 1) * height) {
    throw new DataError("invalid_argument", "The PNG image data has the wrong length.");
  }

  const pixels = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * (stride + 1);
    const filter = raw[rowStart] as number;
    for (let index = 0; index < stride; index += 1) {
      const value = raw[rowStart + 1 + index] as number;
      const left = index >= channels ? (current[index - channels] as number) : 0;
      const above = previous[index] as number;
      const aboveLeft = index >= channels ? (previous[index - channels] as number) : 0;
      let reconstructed: number;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + above;
          break;
        case 3:
          reconstructed = value + Math.floor((left + above) / 2);
          break;
        case 4: {
          const estimate = left + above - aboveLeft;
          const distanceLeft = Math.abs(estimate - left);
          const distanceAbove = Math.abs(estimate - above);
          const distanceAboveLeft = Math.abs(estimate - aboveLeft);
          const paeth =
            distanceLeft <= distanceAbove && distanceLeft <= distanceAboveLeft
              ? left
              : distanceAbove <= distanceAboveLeft
                ? above
                : aboveLeft;
          reconstructed = value + paeth;
          break;
        }
        default:
          throw new DataError("invalid_argument", "The PNG uses an unknown scanline filter.");
      }
      current[index] = reconstructed & 0xff;
    }
    for (let column = 0; column < width; column += 1) {
      const target = (row * width + column) * 4;
      const source = column * channels;
      if (channels === 1) {
        const grey = current[source] as number;
        pixels[target] = grey;
        pixels[target + 1] = grey;
        pixels[target + 2] = grey;
        pixels[target + 3] = 255;
      } else {
        pixels[target] = current[source] as number;
        pixels[target + 1] = current[source + 1] as number;
        pixels[target + 2] = current[source + 2] as number;
        pixels[target + 3] = channels === 4 ? (current[source + 3] as number) : 255;
      }
    }
    previous.set(current);
  }
  return { width, height, pixels };
}

export interface RegionColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
  readonly sampled_pixels: number;
}

/** The mean color of one pixel-space region, normalized to the 0..1 range. */
export function meanRegionColor(
  image: DecodedImage,
  region: { x: number; y: number; width: number; height: number },
): RegionColor | undefined {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(image.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(image.height, Math.ceil(region.y + region.height));
  if (right <= left || bottom <= top) {
    return undefined;
  }
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const index = (row * image.width + column) * 4;
      red += image.pixels[index] as number;
      green += image.pixels[index + 1] as number;
      blue += image.pixels[index + 2] as number;
      alpha += image.pixels[index + 3] as number;
    }
  }
  const count = (right - left) * (bottom - top);
  return {
    red: red / count / 255,
    green: green / count / 255,
    blue: blue / count / 255,
    alpha: alpha / count / 255,
    sampled_pixels: count,
  };
}

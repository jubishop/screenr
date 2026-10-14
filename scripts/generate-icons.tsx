import { readFile, writeFile } from "node:fs/promises";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { ImageResponse } from "next/og";

// src/app/icon.svg is the app icon's source. After editing it, run
// `npx tsx scripts/generate-icons.tsx` and commit the regenerated images.
// Rendering uses the resvg build bundled in Next, not system image tools.
async function png(svg: string, size: number) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const image = new ImageResponse(
    <img src={src} width={size} height={size} alt="" />,
    { width: size, height: size },
  );
  return Buffer.from(await image.arrayBuffer());
}

// An ICO file can hold PNG images directly; every current browser reads them.
function ico(images: { size: number; data: Buffer }[]) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size, entry);
    header.writeUInt8(size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

// App Store Connect rejects an app icon with an alpha channel, so re-encode
// resvg's opaque 8-bit RGBA output as RGB.
function withoutAlpha(rgba: Buffer) {
  const signature = rgba.subarray(0, 8);
  const ihdr = Buffer.from(rgba.subarray(16, 29));
  const [width, height] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
  if (ihdr.readUInt8(8) !== 8 || ihdr.readUInt8(9) !== 6 || ihdr.readUInt8(12))
    throw new Error("Expected a non-interlaced 8-bit RGBA PNG.");
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < rgba.length;) {
    const length = rgba.readUInt32BE(offset);
    if (rgba.toString("latin1", offset + 4, offset + 8) === "IDAT")
      compressed.push(rgba.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const scanlines = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const rgb = Buffer.alloc((width * 3 + 1) * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = scanlines[start];
    const row = Buffer.from(scanlines.subarray(start + 1, start + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      const estimate = left + up - upLeft;
      const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map((value) =>
        Math.abs(estimate - value),
      );
      const paeth =
        toLeft <= toUp && toLeft <= toUpLeft
          ? left
          : toUp <= toUpLeft
            ? up
            : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      if (predictor === undefined) throw new Error("Unknown PNG filter.");
      row[x] = (row[x] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      if (row[x * 4 + 3] !== 0xff)
        throw new Error("An app icon must be fully opaque.");
      row.copy(rgb, y * (width * 3 + 1) + 1 + x * 3, x * 4, x * 4 + 3);
    }
    previous = row;
  }
  ihdr.writeUInt8(2, 9);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rgb, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function replaceOnce(svg: string, from: string, to: string) {
  if (svg.split(from).length !== 2)
    throw new Error(`icon.svg must contain ${from} exactly once.`);
  return svg.replace(from, to);
}

export async function renderAppIcons() {
  const rounded = await readFile("src/app/icon.svg", "utf8");
  if (rounded.match(/ rx="\d+"/g)?.length !== 1)
    throw new Error("icon.svg must have exactly one corner radius.");
  // iOS and Android maskable icons apply their own shape to a full square.
  const square = rounded.replace(/ rx="\d+"/, "");
  // Screenr Dev swaps to the lime accent so the two apps differ at a glance.
  const dev = [
    ['fill="#163c34"', 'fill="#d9eb85"'],
    ['stroke="#f7f6f0"', 'stroke="#163c34"'],
    ['fill="#88a841"', 'fill="#163c34"'],
  ].reduce((svg, [from, to]) => replaceOnce(svg, from, to), square);
  const favicon = await Promise.all(
    [16, 32, 48].map(async (size) => ({
      size,
      data: await png(rounded, size),
    })),
  );
  const iosAssets = "ios/Screenr/Assets.xcassets";
  return new Map([
    ["src/app/favicon.ico", ico(favicon)],
    ["src/app/apple-icon.png", await png(square, 180)],
    ["public/icons/icon-192.png", await png(rounded, 192)],
    ["public/icons/icon-512.png", await png(rounded, 512)],
    ["public/icons/maskable-512.png", await png(square, 512)],
    [
      `${iosAssets}/AppIcon.appiconset/AppIcon.png`,
      withoutAlpha(await png(square, 1024)),
    ],
    [
      `${iosAssets}/DevAppIcon.appiconset/DevAppIcon.png`,
      withoutAlpha(await png(dev, 1024)),
    ],
  ]);
}

if (process.argv[1]?.endsWith("scripts/generate-icons.tsx"))
  for (const [path, data] of await renderAppIcons())
    await writeFile(path, data);

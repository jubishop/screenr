import { readFile, writeFile } from "node:fs/promises";
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

export async function renderAppIcons() {
  const rounded = await readFile("src/app/icon.svg", "utf8");
  if (rounded.match(/ rx="\d+"/g)?.length !== 1)
    throw new Error("icon.svg must have exactly one corner radius.");
  // iOS and Android maskable icons apply their own shape to a full square.
  const square = rounded.replace(/ rx="\d+"/, "");
  const favicon = await Promise.all(
    [16, 32, 48].map(async (size) => ({
      size,
      data: await png(rounded, size),
    })),
  );
  return new Map([
    ["src/app/favicon.ico", ico(favicon)],
    ["src/app/apple-icon.png", await png(square, 180)],
    ["public/icons/icon-192.png", await png(rounded, 192)],
    ["public/icons/icon-512.png", await png(rounded, 512)],
    ["public/icons/maskable-512.png", await png(square, 512)],
  ]);
}

if (process.argv[1]?.endsWith("scripts/generate-icons.tsx"))
  for (const [path, data] of await renderAppIcons())
    await writeFile(path, data);

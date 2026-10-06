// Writes a sample manifest and placeholder logos to public/sample for local work (phase 1).
// Run: npm run sample. Then set NEXT_PUBLIC_FILES_BASE=/sample in .env.local.
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

const OUT = new URL("../public/sample/", import.meta.url);
const NAMES = [
  "Pampa Labs", "Mate Pay", "Andes AI", "Tango Data", "Ñandú Cloud", "Asado Ops", "Gaucho Bank",
  "Ruta 40", "Malbec ML", "Patagonia Dev", "Obelisco", "Dulce Stack", "Fernet Fin", "Glaciar",
  "Puerto Logs", "Cóndor Sec", "Yerba Health", "Pibe Robotics", "Quebrada", "Bandoneón",
];
const COLORS = ["#1d3557", "#e63946", "#2a9d8f", "#f4a261", "#6a4c93", "#264653", "#d62828", "#0077b6"];

await mkdir(OUT, { recursive: true });
const logos = [];
for (const [i, name] of NAMES.entries()) {
  const id = randomUUID();
  const color = COLORS[i % COLORS.length];
  const wide = i % 3 !== 0;
  const [w, h] = wide ? [480, 200] : [320, 320];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <circle cx="${wide ? 90 : w / 2}" cy="${wide ? h / 2 : 120}" r="${wide ? 62 : 80}" fill="${color}"/>
    <text x="${wide ? 90 : w / 2}" y="${wide ? h / 2 + 22 : 145}" font-family="Arial" font-weight="700"
      font-size="${wide ? 64 : 80}" fill="#fff" text-anchor="middle">${name[0]}</text>
    <text x="${wide ? 170 : w / 2}" y="${wide ? h / 2 + 16 : 270}" font-family="Arial" font-weight="700"
      font-size="${wide ? 44 : 40}" fill="${color}" text-anchor="${wide ? "start" : "middle"}">${name}</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(new URL(`${id}.png`, OUT), png);
  const domain = `${name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "")}.com.ar`;
  logos.push({ id, domain, url: `https://${domain}/`, image: `${id}.png` });
}
await writeFile(
  new URL("manifest.json", OUT),
  JSON.stringify({ version: 1, updated_at: new Date().toISOString(), logos }, null, 2),
);
console.log(`Wrote ${logos.length} sample logos to public/sample`);

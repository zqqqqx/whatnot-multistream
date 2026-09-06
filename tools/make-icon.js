// Baut aus build/icon.svg die App-Symbole: eine PNG fuer Linux/Vorschau und
// eine ICO mit allen Groessen, die Windows fuer Taskleiste, Explorer und
// Verknuepfungen braucht.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const root = path.join(__dirname, '..');
const svg = path.join(root, 'build', 'icon.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const source = fs.readFileSync(svg);

  await sharp(source, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(root, 'build', 'icon.png'));

  const frames = [];
  for (const size of sizes) {
    frames.push(await sharp(source, { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer());
  }

  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), await pngToIco(frames));
  console.log('icon.png und icon.ico geschrieben (' + sizes.join(', ') + ')');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

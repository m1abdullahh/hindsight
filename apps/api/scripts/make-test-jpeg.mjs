import sharp from 'sharp';

const out = process.argv[2] ?? './test-screenshot.jpg';

const info = await sharp({
  create: { width: 800, height: 600, channels: 3, background: { r: 50, g: 100, b: 150 } },
})
  .jpeg({ quality: 80 })
  .toFile(out);

console.log(`written ${out} (${info.size} bytes)`);

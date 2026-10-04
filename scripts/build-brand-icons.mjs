// Deterministic raster fallbacks from the supplied vector, using Chromium's SVG renderer.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const svg = readFileSync('frontend/public/logo.svg', 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const [size, file] of [[16, 'favicon-16.png'], [32, 'favicon-32.png'], [180, 'apple-touch-icon.png'], [512, 'logo-512.png']]) {
    const data = await page.evaluate(async ({ source, size }) => {
      const image = new Image();
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source: svg, size });
    writeFileSync(`frontend/public/${file}`, Buffer.from(data, 'base64'));
  }
} finally { await browser.close(); }

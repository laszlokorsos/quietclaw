/**
 * Generate QuietClaw icons from SVG templates.
 *
 * Creates:
 *   resources/tray-icon.png          — 32x32 menu bar icon (idle)
 *   resources/tray-icon-recording.png — 32x32 menu bar icon (recording)
 *   resources/icon.png               — 512x512 app icon
 */

import sharp from 'sharp'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const resourcesDir = join(__dirname, '..', 'resources')

// Cat paw silhouette SVG — designed for macOS template image (black on transparent).
// Three toe beans on top, one large palm pad below, with subtle claw tips.
const pawSvg = (size, recording = false) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <!-- Toe beans (3 toes) -->
  <ellipse cx="9" cy="7" rx="3.5" ry="4" fill="black"/>
  <ellipse cx="16" cy="5" rx="3.5" ry="4" fill="black"/>
  <ellipse cx="23" cy="7" rx="3.5" ry="4" fill="black"/>

  <!-- Claw tips -->
  <path d="M6.5 3.5 L5 1 L7 2.5" fill="black"/>
  <path d="M15 1.5 L15.5 -1 L16.5 2" fill="black"/>
  <path d="M25.5 3.5 L27 1 L25 2.5" fill="black"/>

  <!-- Main palm pad -->
  <ellipse cx="16" cy="18" rx="9" ry="8" fill="black"/>

  ${recording ? `
  <!-- Recording indicator dot (red won't show in template mode, so use a cutout circle) -->
  <circle cx="26" cy="26" r="5" fill="black"/>
  <circle cx="26" cy="26" r="3" fill="white"/>
  <circle cx="26" cy="26" r="2" fill="black"/>
  ` : ''}
</svg>
`

// Full color app icon — purple/indigo paw on dark background
const appIconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="100%" stop-color="#312e81"/>
    </linearGradient>
    <linearGradient id="paw" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a78bfa"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>

  <!-- Rounded square background -->
  <rect x="0" y="0" width="512" height="512" rx="100" fill="url(#bg)"/>

  <!-- Paw scaled up to fit 512x512 with padding -->
  <g transform="translate(96, 80) scale(10)">
    <!-- Toe beans -->
    <ellipse cx="9" cy="7" rx="3.5" ry="4" fill="url(#paw)"/>
    <ellipse cx="16" cy="5" rx="3.5" ry="4" fill="url(#paw)"/>
    <ellipse cx="23" cy="7" rx="3.5" ry="4" fill="url(#paw)"/>

    <!-- Claw tips -->
    <path d="M6.5 3.5 L5 1 L7 2.5" fill="url(#paw)" stroke="url(#paw)" stroke-width="0.5"/>
    <path d="M15 1.5 L15.5 -1 L16.5 2" fill="url(#paw)" stroke="url(#paw)" stroke-width="0.5"/>
    <path d="M25.5 3.5 L27 1 L25 2.5" fill="url(#paw)" stroke="url(#paw)" stroke-width="0.5"/>

    <!-- Main palm pad -->
    <ellipse cx="16" cy="18" rx="9" ry="8" fill="url(#paw)"/>
  </g>
</svg>
`

async function generate() {
  // Tray icon — idle (32x32 for Retina, displayed at 16x16)
  await sharp(Buffer.from(pawSvg(32, false)))
    .resize(32, 32)
    .png()
    .toFile(join(resourcesDir, 'tray-icon.png'))
  console.log('Created tray-icon.png (32x32)')

  // Tray icon — recording (32x32)
  await sharp(Buffer.from(pawSvg(32, true)))
    .resize(32, 32)
    .png()
    .toFile(join(resourcesDir, 'tray-icon-recording.png'))
  console.log('Created tray-icon-recording.png (32x32)')

  // App icon (512x512)
  await sharp(Buffer.from(appIconSvg))
    .resize(512, 512)
    .png()
    .toFile(join(resourcesDir, 'icon.png'))
  console.log('Created icon.png (512x512)')

  console.log('Done!')
}

generate().catch(console.error)

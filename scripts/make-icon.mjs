// Generates build/icon.ico (Windows installer/app) from
// frontend/assets/icon.svg — the single source icon (also used by the app
// header). Linux uses frontend/assets/icon.png, so no PNG/SVG is duplicated
// under build/. Run with: npm run icon
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { PNG } from 'pngjs'
import pngToIco from 'png-to-ico'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = path.join(root, 'frontend', 'assets', 'icon.svg')
const outIco = path.join(root, 'build', 'icon.ico')

const svg = readFileSync(svgPath, 'utf8')

// Renders the (near-square) SVG centered on a transparent square canvas.
function renderSquare(size) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  }).render()
  const src = PNG.sync.read(rendered.asPng())
  const canvas = new PNG({ width: size, height: size })
  canvas.data.fill(0)
  const offsetX = Math.max(0, Math.floor((size - src.width) / 2))
  const offsetY = Math.max(0, Math.floor((size - src.height) / 2))
  PNG.bitblt(src, canvas, 0, 0, src.width, src.height, offsetX, offsetY)
  return PNG.sync.write(canvas)
}

mkdirSync(path.dirname(outIco), { recursive: true })

const ico = await pngToIco(renderSquare(256))
writeFileSync(outIco, ico)
console.log(`icon.ico generated (256/48/32/16): ${outIco}`)

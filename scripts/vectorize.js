const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')
const ImageTracer = require('imagetracerjs')

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const flags = {}
for (const a of args) {
  const m = a.match(/^--([^=]+)=(.*)$/)
  if (m) flags[m[1]] = m[2]
}

const srcArg = positional[0]
const outArg = positional[1]
const LABEL = positional[2] || (outArg ? path.basename(outArg, path.extname(outArg)) : 'image')
if (!srcArg || !outArg) {
  console.error('usage: node scripts/vectorize.js <src.png|src.svg> <out.svg> [label] [--k=16] [--ltres=3] [--pathomit=24] [--median=1] [--trace=0] [--size=0] [--ncolors=0] [--blur=0]')
  process.exit(1)
}

const K = Number(flags.k || 16)
const LTRES = Number(flags.ltres || 3)
const PATHOMIT = Number(flags.pathomit || 24)
const USE_MEDIAN = (flags.median || '1') !== '0'
const TRACE_W = Number(flags.trace || 0)
const OUT_SIZE = Number(flags.size || 0)
const NCOLORS = Number(flags.ncolors || 0)
const BLUR = Number(flags.blur || 0)

function loadPng(file) {
  const buf = fs.readFileSync(file)
  if (buf.slice(0, 8).toString('latin1').includes('PNG')) return PNG.sync.read(buf)
  const m = buf.toString('utf8').match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
  if (!m) throw new Error('no inline PNG found in ' + file)
  return PNG.sync.read(Buffer.from(m[1], 'base64'))
}

function downscale(png, tw) {
  const f = png.width / tw
  const th = Math.round(png.height / f)
  const out = new PNG({ width: tw, height: th })
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * f), x1 = Math.min(png.width, Math.ceil((x + 1) * f))
      const y0 = Math.floor(y * f), y1 = Math.min(png.height, Math.ceil((y + 1) * f))
      let r = 0, g = 0, b = 0, n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const si = (png.width * yy + xx) << 2
          if (png.data[si + 3] < 128) continue
          r += png.data[si]; g += png.data[si + 1]; b += png.data[si + 2]; n++
        }
      }
      const di = (tw * y + x) << 2
      if (!n) { out.data[di + 3] = 0; continue }
      out.data[di] = Math.round(r / n); out.data[di + 1] = Math.round(g / n); out.data[di + 2] = Math.round(b / n); out.data[di + 3] = 255
    }
  }
  return out
}

let png = loadPng(srcArg)
if (TRACE_W && TRACE_W < png.width) png = downscale(png, TRACE_W)
const { width: W, height: H } = png
const idx = (x, y) => (y * W + x) << 2
const opaque = (i) => png.data[i + 3] >= 128

function median3(data) {
  const out = Buffer.from(data)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const di = idx(x, y)
      if (!opaque(di)) continue
      for (const c of [0, 1, 2]) {
        const vals = []
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            const ni = idx(nx, ny)
            if (opaque(ni)) vals.push(data[ni + c])
          }
        }
        vals.sort((a, b) => a - b)
        out[di + c] = vals[vals.length >> 1]
      }
    }
  }
  return out
}

function quantize(data, k, iters) {
  const samples = []
  for (let i = 0; i < W * H; i++) {
    const o = i << 2
    if (data[o + 3] >= 128) samples.push([data[o], data[o + 1], data[o + 2]])
  }
  const centers = []
  for (let c = 0; c < k; c++) {
    centers.push(samples[Math.floor(((c + 0.5) / k) * samples.length)].slice())
  }
  for (let it = 0; it < iters; it++) {
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0])
    for (const p of samples) {
      let bi = 0, bd = Infinity
      for (let c = 0; c < k; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2
        if (d < bd) { bd = d; bi = c }
      }
      const s = sum[bi]
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++
    }
    for (let c = 0; c < k; c++) {
      if (sum[c][3]) centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]]
    }
  }
  const out = Buffer.from(data)
  for (let i = 0; i < W * H; i++) {
    const o = i << 2
    if (data[o + 3] < 128) { out[o + 3] = 0; continue }
    let bi = 0, bd = Infinity
    for (let c = 0; c < k; c++) {
      const d = (data[o] - centers[c][0]) ** 2 + (data[o + 1] - centers[c][1]) ** 2 + (data[o + 2] - centers[c][2]) ** 2
      if (d < bd) { bd = d; bi = c }
    }
    out[o] = Math.round(centers[bi][0])
    out[o + 1] = Math.round(centers[bi][1])
    out[o + 2] = Math.round(centers[bi][2])
    out[o + 3] = 255
  }
  return out
}

const options = {
  ...ImageTracer.optionpresets.default,
  ltres: LTRES,
  qtres: LTRES,
  pathomit: PATHOMIT,
  colorsampling: 2,
  colorquantcycles: 3,
  mincolorratio: 0,
  blurradius: BLUR,
  strokewidth: 0,
  scale: 1,
  roundcoords: 1,
  viewbox: true,
}

let prepared = USE_MEDIAN ? median3(png.data) : png.data
if (NCOLORS) options.numberofcolors = NCOLORS
else prepared = quantize(prepared, K, 6)

const traced = ImageTracer.imagedataToSVG({ width: W, height: H, data: prepared }, options)

let inner = traced.slice(traced.indexOf('>') + 1, traced.lastIndexOf('</svg>'))
inner = inner.replace(/ stroke="[^"]*"/g, '')
inner = inner.replace(/ stroke-width="[^"]*"/g, '')
inner = inner.replace(/<path[^>]*opacity="0(\.[0-3]\d*)?"[^>]*\/>/g, '')
inner = inner.replace(/></g, '>\n<')

const size = OUT_SIZE || W
const scale = size / W
const body = scale === 1 ? inner : `<g transform="scale(${scale})">${inner}</g>`
const header = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * (H / W))}" viewBox="0 0 ${size} ${Math.round(size * (H / W))}" role="img" aria-label="${LABEL}">`
const svg = `${header}${body}</svg>\n`

fs.mkdirSync(path.dirname(outArg), { recursive: true })
fs.writeFileSync(outArg, svg)
console.log({ out: outArg, source: `${W}x${H}`, output: size, bytes: svg.length, paths: (svg.match(/<path/g) || []).length })

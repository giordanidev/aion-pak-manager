const fs = require('fs')
const { PNG } = require('pngjs')
const ImageTracer = require('imagetracerjs')

const buf = fs.readFileSync('build/shugo-trace-src.png')
const png = PNG.sync.read(buf)
const imageData = { width: png.width, height: png.height, data: png.data }

const options = {
  ...ImageTracer.optionpresets.default,
  numberofcolors: 5,
  pathomit: 16,
  ltres: 1.2,
  qtres: 1.2,
  scale: 1,
  viewbox: true,
  blurradius: 0,
  strokewidth: 0,
}

let svg = ImageTracer.imagedataToSVG(imageData, options)

// Drop near-transparent / junk fringe paths
svg = svg.replace(/<path[^>]*opacity="0\.[0-3][^"]*"[^>]*\/?>/g, '')
svg = svg.replace(/ stroke="[^"]*"/g, '')
svg = svg.replace(/ stroke-width="[^"]*"/g, '')

svg = svg.replace(/viewBox="[^"]*"/, 'viewBox="0 0 512 512"')
svg = svg.replace(
  /<svg /,
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" role="img" aria-label="Shugo" ',
)

fs.writeFileSync('frontend/assets/shugo.svg', svg)
const paths = (svg.match(/<path/g) || []).length
console.log({ bytes: svg.length, paths })

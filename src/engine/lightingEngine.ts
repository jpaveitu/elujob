// @ts-nocheck
// ============================================================
//  ELUX — Motor de Cálculo Lumínico
//  Punto a punto (CIE 140) + corrección por interreflexiones
//  + generador de isolíneas (Marching Squares simplificado)
// ============================================================

import { getIntensityIES, getCandelaDistributionIES } from './iesParser'
import type {
  LuminairePreset, LightSource, Luminaire, Room,
  CalcResult, SpaceNorm,
} from './types'

// ── Presets cos^n ─────────────────────────────────────────

function makePreset(
  id: string, nombre: string, cat: string,
  lm: number, w: number, ha: number
): LuminairePreset {
  const rad = (ha * Math.PI) / 180
  const n   = Math.log(0.5) / Math.log(Math.cos(rad))
  const I0  = (lm * (n + 1)) / (2 * Math.PI)
  return { id, nombre, categoria: cat, lumens: lm, watts: w, halfAngle: ha, n, I0 }
}

export const LUMINAIRES: LuminairePreset[] = [
  // Downlights
  makePreset('dl-25-800',   'Downlight 25° — 800 lm / 8W',    'Downlight',   800,   8,  12.5),
  makePreset('dl-40-1200',  'Downlight 40° — 1200 lm / 11W',  'Downlight',  1200,  11,  20),
  makePreset('dl-60-1500',  'Downlight 60° — 1500 lm / 12W',  'Downlight',  1500,  12,  30),
  makePreset('dl-90-2500',  'Downlight 90° — 2500 lm / 18W',  'Downlight',  2500,  18,  45),
  // Paneles
  makePreset('panel-3000',  'Panel LED 60×60 — 3000 lm / 24W','Panel',      3000,  24,  60),
  makePreset('panel-4000',  'Panel LED 60×60 — 4000 lm / 30W','Panel',      4000,  30,  60),
  makePreset('panel-6000',  'Panel LED 120×30 — 6000 lm / 45W','Panel',     6000,  45,  60),
  // Industrial
  makePreset('hb-60-15k',   'Highbay 60° — 15 000 lm / 100W', 'Industrial',15000, 100,  30),
  makePreset('hb-90-20k',   'Highbay 90° — 20 000 lm / 120W', 'Industrial',20000, 120,  45),
  makePreset('hb-120-30k',  'Highbay 120° — 30 000 lm / 200W','Industrial',30000, 200,  60),
  // Proyectores
  makePreset('spot-15',     'Proyector 15° — 2000 lm / 20W',  'Proyector',  2000,  20,   7.5),
  makePreset('spot-30',     'Proyector 30° — 3000 lm / 25W',  'Proyector',  3000,  25,  15),
  makePreset('spot-60',     'Proyector 60° — 5000 lm / 40W',  'Proyector',  5000,  40,  30),
  // Lineales
  makePreset('lineal-2400', 'Lineal LED 1200mm — 2400 lm / 20W','Lineal',   2400,  20,  60),
  makePreset('lineal-4000', 'Lineal LED 1500mm — 4000 lm / 30W','Lineal',   4000,  30,  60),
  // Alumbrado público
  makePreset('vial-8000',   'Luminaria Vial — 8000 lm / 60W', 'Vial',       8000,  60,  60),
  makePreset('vial-14000',  'Luminaria Vial — 14000 lm / 100W','Vial',     14000, 100,  75),
]

function getIntensityPreset(p: LuminairePreset, gammaDeg: number): number {
  if (gammaDeg >= 90) return 0
  return p.I0 * Math.pow(Math.cos((gammaDeg * Math.PI) / 180), p.n)
}

export function getIntensity(src: LightSource, gammaDeg: number, phiDeg = 0): number {
  return src.type === 'preset'
    ? getIntensityPreset(src.preset, gammaDeg)
    : getIntensityIES(src.ies, gammaDeg, phiDeg)
}

export function getCandelaDistribution(source: LightSource): number[] {
  return source.type === 'ies'
    ? getCandelaDistributionIES(source.ies)
    : Array.from({ length: 91 }, (_, g) => getIntensity(source, g, 0))
}

export function sourceLumens(src: LightSource): number {
  return src.type === 'preset' ? src.preset.lumens : src.ies.totalFlux
}
export function sourceWatts(src: LightSource): number {
  return src.type === 'preset' ? src.preset.watts : src.ies.inputWatts
}
export function sourceName(src: LightSource): string {
  return src.type === 'preset' ? src.preset.nombre : src.ies.luminaireName
}

// ── Tipos de espacio (RIC N°10 / EN 12464-1:2021) ─────────

export const SPACE_TYPES: SpaceNorm[] = [
  { id: 'oficina',   nombre: 'Oficina / Escritorios',    EmMin: 500,  UGRmax: 19, Ramin: 80, Uomin: 0.6, categoria: 'Trabajo' },
  { id: 'reunion',   nombre: 'Sala de Reuniones',         EmMin: 500,  UGRmax: 19, Ramin: 80, Uomin: 0.6, categoria: 'Trabajo' },
  { id: 'cad',       nombre: 'Dibujo CAD / Técnico',      EmMin: 750,  UGRmax: 16, Ramin: 80, Uomin: 0.7, categoria: 'Trabajo' },
  { id: 'aula',      nombre: 'Aula / Sala de Clases',     EmMin: 500,  UGRmax: 19, Ramin: 80, Uomin: 0.6, categoria: 'Educación' },
  { id: 'pasillo',   nombre: 'Pasillo / Circulación',     EmMin: 100,  UGRmax: 28, Ramin: 40, Uomin: 0.4, categoria: 'Circulación' },
  { id: 'escalera',  nombre: 'Escalera / Rampa',          EmMin: 150,  UGRmax: 25, Ramin: 40, Uomin: 0.4, categoria: 'Circulación' },
  { id: 'bodega-b',  nombre: 'Bodega — Actividad Baja',   EmMin: 100,  UGRmax: 25, Ramin: 60, Uomin: 0.4, categoria: 'Industrial' },
  { id: 'bodega-a',  nombre: 'Bodega con Picking',         EmMin: 200,  UGRmax: 25, Ramin: 60, Uomin: 0.4, categoria: 'Industrial' },
  { id: 'ind-lig',   nombre: 'Industrial Ligero',          EmMin: 300,  UGRmax: 22, Ramin: 80, Uomin: 0.5, categoria: 'Industrial' },
  { id: 'ind-pes',   nombre: 'Industrial Pesado',          EmMin: 750,  UGRmax: 19, Ramin: 80, Uomin: 0.5, categoria: 'Industrial' },
  { id: 'comercio',  nombre: 'Comercio / Retail',          EmMin: 500,  UGRmax: 22, Ramin: 90, Uomin: 0.6, categoria: 'Comercial' },
  { id: 'hotel',     nombre: 'Hotel / Recepción',          EmMin: 300,  UGRmax: 22, Ramin: 80, Uomin: 0.4, categoria: 'Comercial' },
  { id: 'medico',    nombre: 'Área Médica / Examen',       EmMin: 1000, UGRmax: 19, Ramin: 90, Uomin: 0.7, categoria: 'Salud' },
  { id: 'quirofano', nombre: 'Quirófano',                  EmMin: 1000, UGRmax: 19, Ramin: 90, Uomin: 0.7, categoria: 'Salud' },
  { id: 'estadio',   nombre: 'Cancha Deportiva Interior',  EmMin: 500,  UGRmax: 22, Ramin: 65, Uomin: 0.5, categoria: 'Deporte' },
  { id: 'piscina',   nombre: 'Piscina Interior',            EmMin: 300,  UGRmax: 25, Ramin: 80, Uomin: 0.4, categoria: 'Deporte' },
  { id: 'parking',   nombre: 'Parking / Garaje',           EmMin: 75,   UGRmax: 25, Ramin: 40, Uomin: 0.4, categoria: 'Exterior' },
]

// ── Motor de cálculo ──────────────────────────────────────

const GRID_N = 60   // resolución de la cuadrícula

/**
 * Factor de corrección por interreflexiones (método simplificado BK)
 * Se basa en la reflectancia media ponderada del recinto.
 */
function interreflectionFactor(room: Room): number {
  const { largo: a, ancho: b, alto: h, rTecho: rc, rParedes: rw, rSuelo: rf } = room
  // Índice de local K
  const hm = h - room.hPlan
  const K = (a * b) / (hm * (a + b))
  // Reflectancia media simplificada
  const Sm  = (rc * (a*b) + rw * (2*h*(a+b)) + rf * (a*b)) / (2*(a*b) + 2*h*(a+b))
  // Factor de corrección (aprox. BK para reflexiones múltiples)
  const factor = 1 / (1 - Sm * (1 - 1 / (1 + K)))
  return Math.min(1.35, Math.max(1.0, factor))
}

export function calculateLighting(
  luminaires: Luminaire[],
  room: Room,
  fm: number
): CalcResult {
  if (luminaires.length === 0) {
    const g = new Float32Array(GRID_N * GRID_N)
    return {
      grid: g, GR: GRID_N, GC: GRID_N,
      Em: 0, Emin: 0, Emax: 0, Uo: 0,
      totalW: 0, totalLm: 0, DPEA: 0, isolines: [],
    }
  }

  const { largo: a, ancho: b } = room
  const hm = room.alto - room.hPlan   // altura montaje sobre plano trabajo
  const irf = interreflectionFactor(room)

  const GR = GRID_N, GC = GRID_N
  const grid = new Float32Array(GR * GC)

  for (let gr = 0; gr < GR; gr++) {
    const py = (b / (GR - 1)) * gr
    for (let gc = 0; gc < GC; gc++) {
      const px = (a / (GC - 1)) * gc
      let E = 0
      for (const lum of luminaires) {
        const src = lum.source
        const dx = px - lum.x
        const dy = py - lum.y
        const dH = Math.sqrt(dx*dx + dy*dy)
        const dT = Math.sqrt(dH*dH + hm*hm)
        const gammaDeg = (Math.atan2(dH, hm) * 180) / Math.PI
        const phiDeg   = (Math.atan2(dy, dx) * 180) / Math.PI
        const I = getIntensity(src, gammaDeg, phiDeg)
        // E = I·cos(θ)/d² (componente directa)
        E += (I / (dT * dT)) * (hm / dT) * lum.dimming
      }
      grid[gr * GC + gc] = E * fm * irf
    }
  }

  let sum = 0, minV = Infinity, maxV = -Infinity
  for (let k = 0; k < grid.length; k++) {
    const v = grid[k]; sum += v
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  const Em = sum / grid.length

  const totalWatts  = luminaires.reduce((s, l) => s + sourceWatts(l.source), 0)
  const totalLumens = luminaires.reduce((s, l) => s + sourceLumens(l.source), 0)
  const DPEA = totalWatts / (a * b)

  // Isolíneas automáticas (cada 100 lux o ajuste dinámico)
  const step = Em < 200 ? 50 : Em < 1000 ? 100 : 250
  const isoValues: number[] = []
  for (let v = Math.ceil(minV / step) * step; v <= maxV; v += step)
    if (v > 10) isoValues.push(v)

  const isolines = isoValues.map(val => ({
    value: val,
    segs: marchingSquares(grid, GR, GC, a, b, val),
  }))

  return {
    grid, GR, GC,
    Em, Emin: minV, Emax: maxV, Uo: minV / Em,
    totalW: totalWatts, totalLm: totalLumens, DPEA, isolines,
  }
}

// ── Marching Squares (isolíneas) ──────────────────────────

function marchingSquares(
  grid: Float32Array,
  GR: number, GC: number,
  roomW: number, roomH: number,
  threshold: number
): [number, number, number, number][] {
  const segs: [number, number, number, number][] = []
  const val = (r: number, c: number) => grid[r * GC + c]
  const px  = (c: number) => (c / (GC - 1)) * roomW
  const py  = (r: number) => (r / (GR - 1)) * roomH

  const lerp = (a: number, b: number, va: number, vb: number) =>
    a + (b - a) * (threshold - va) / (vb - va)

  for (let r = 0; r < GR - 1; r++) {
    for (let c = 0; c < GC - 1; c++) {
      const v00 = val(r,   c),   v10 = val(r,   c+1)
      const v01 = val(r+1, c),   v11 = val(r+1, c+1)
      const idx = (+(v00 >= threshold)) | ((+(v10 >= threshold)) << 1) |
                  ((+(v11 >= threshold)) << 2) | ((+(v01 >= threshold)) << 3)
      if (idx === 0 || idx === 15) continue

      // Posiciones de bordes interpoladas
      const top    = { x: lerp(px(c), px(c+1), v00, v10), y: py(r)   }
      const bottom = { x: lerp(px(c), px(c+1), v01, v11), y: py(r+1) }
      const left   = { x: px(c),   y: lerp(py(r), py(r+1), v00, v01) }
      const right  = { x: px(c+1), y: lerp(py(r), py(r+1), v10, v11) }

      const addSeg = (a: {x:number,y:number}, b: {x:number,y:number}) =>
        segs.push([a.x, a.y, b.x, b.y])

      switch (idx) {
        case 1: case 14: addSeg(top, left); break
        case 2: case 13: addSeg(top, right); break
        case 3: case 12: addSeg(left, right); break
        case 4: case 11: addSeg(bottom, right); break
        case 5: addSeg(top, right); addSeg(bottom, left); break
        case 6: case 9:  addSeg(top, bottom); break
        case 7: case 8:  addSeg(bottom, left); break
        case 10: addSeg(top, left); addSeg(bottom, right); break
      }
    }
  }
  return segs
}

// ── Mapa de color falso (estilo DIALux) ──────────────────

const COLOR_STOPS: [number, number, number][] = [
  [5,   5,  30],   // casi negro
  [10,  35, 160],  // azul oscuro
  [0,  160, 160],  // cyan
  [60, 195,  50],  // verde
  [255,210,   0],  // amarillo
  [255, 50,   0],  // rojo
]

export function luxToRGB(lux: number, maxLux: number): [number, number, number] {
  const t  = Math.max(0, Math.min(1, lux / maxLux))
  const sc = t * (COLOR_STOPS.length - 1)
  const lo = Math.floor(sc)
  const hi = Math.min(COLOR_STOPS.length - 1, lo + 1)
  const f  = sc - lo
  return [
    Math.round(COLOR_STOPS[lo][0] * (1-f) + COLOR_STOPS[hi][0] * f),
    Math.round(COLOR_STOPS[lo][1] * (1-f) + COLOR_STOPS[hi][1] * f),
    Math.round(COLOR_STOPS[lo][2] * (1-f) + COLOR_STOPS[hi][2] * f),
  ]
}

export function bilinearSample(
  grid: Float32Array, GR: number, GC: number, nR: number, nC: number
): number {
  const r = nR * (GR-1), c = nC * (GC-1)
  const r0 = Math.floor(r), r1 = Math.min(GR-1, r0+1)
  const c0 = Math.floor(c), c1 = Math.min(GC-1, c0+1)
  const dr = r-r0, dc = c-c0
  return (
    grid[r0*GC+c0]*(1-dr)*(1-dc) +
    grid[r0*GC+c1]*(1-dr)*dc +
    grid[r1*GC+c0]*dr*(1-dc) +
    grid[r1*GC+c1]*dr*dc
  )
}

export type { LuminairePreset, LightSource, Luminaire, Room, CalcResult }

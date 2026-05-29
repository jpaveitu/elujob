// ============================================================
//  ELUX — Motor de cálculo punto a punto
// ============================================================

import type { Luminaire, Room, CalcResult, LuminairePreset, LightSource, SpaceNorm } from './types'
import { getIntensityIES } from './iesParser'

// ── Presets ───────────────────────────────────────────────
function mkPreset(id:string, nombre:string, cat:string, lm:number, w:number, ha:number): LuminairePreset {
  const rad = ha * Math.PI / 180
  const n   = Math.log(0.5) / Math.log(Math.cos(rad))
  const I0  = lm * (n + 1) / (2 * Math.PI)
  return { id, nombre, categoria: cat, lumens: lm, watts: w, halfAngle: ha, n, I0 }
}

export const PRESETS: LuminairePreset[] = [
  mkPreset('dl-25',    'Downlight 25° – 800 lm / 8 W',      'Downlight',   800,   8,  12.5),
  mkPreset('dl-40',    'Downlight 40° – 1200 lm / 11 W',    'Downlight',  1200,  11,  20),
  mkPreset('dl-60',    'Downlight 60° – 1500 lm / 12 W',    'Downlight',  1500,  12,  30),
  mkPreset('dl-90',    'Downlight 90° – 2500 lm / 18 W',    'Downlight',  2500,  18,  45),
  mkPreset('panel-s',  'Panel 60×60 – 3000 lm / 24 W',      'Panel LED',  3000,  24,  60),
  mkPreset('panel-m',  'Panel 60×60 – 4000 lm / 30 W',      'Panel LED',  4000,  30,  60),
  mkPreset('panel-l',  'Panel 120×30 – 6000 lm / 45 W',     'Panel LED',  6000,  45,  60),
  mkPreset('hb-60',    'Highbay 60° – 15 000 lm / 100 W',   'Industrial',15000, 100,  30),
  mkPreset('hb-90',    'Highbay 90° – 20 000 lm / 120 W',   'Industrial',20000, 120,  45),
  mkPreset('hb-120',   'Highbay 120° – 30 000 lm / 200 W',  'Industrial',30000, 200,  60),
  mkPreset('spot-15',  'Proyector 15° – 2000 lm / 20 W',    'Proyector',  2000,  20,   7.5),
  mkPreset('spot-30',  'Proyector 30° – 3000 lm / 25 W',    'Proyector',  3000,  25,  15),
  mkPreset('lineal',   'Lineal 1200 mm – 2400 lm / 20 W',   'Lineal',     2400,  20,  60),
  mkPreset('vial-60',  'Vial 60 W – 8000 lm',               'Vial',       8000,  60,  60),
  mkPreset('vial-100', 'Vial 100 W – 14 000 lm',            'Vial',      14000, 100,  75),
]

// ── Normativa RIC N°10 / EN 12464-1 ──────────────────────
export const NORMAS: SpaceNorm[] = [
  { id:'oficina',   nombre:'Oficina / escritorios',   EmMin:500,  Uomin:0.6, UGRmax:19, Ramin:80, categoria:'Trabajo'      },
  { id:'reunion',   nombre:'Sala de reuniones',        EmMin:500,  Uomin:0.6, UGRmax:19, Ramin:80, categoria:'Trabajo'      },
  { id:'cad',       nombre:'Dibujo CAD / técnico',     EmMin:750,  Uomin:0.7, UGRmax:16, Ramin:80, categoria:'Trabajo'      },
  { id:'aula',      nombre:'Aula / sala de clases',    EmMin:500,  Uomin:0.6, UGRmax:19, Ramin:80, categoria:'Educación'    },
  { id:'pasillo',   nombre:'Pasillo / circulación',    EmMin:100,  Uomin:0.4, UGRmax:28, Ramin:40, categoria:'Circulación'  },
  { id:'escalera',  nombre:'Escalera / rampa',         EmMin:150,  Uomin:0.4, UGRmax:25, Ramin:40, categoria:'Circulación'  },
  { id:'bodega-b',  nombre:'Bodega – actividad baja',  EmMin:100,  Uomin:0.4, UGRmax:25, Ramin:60, categoria:'Industrial'   },
  { id:'bodega-a',  nombre:'Bodega con picking',        EmMin:200,  Uomin:0.4, UGRmax:25, Ramin:60, categoria:'Industrial'   },
  { id:'ind-lig',   nombre:'Industrial ligero',         EmMin:300,  Uomin:0.5, UGRmax:22, Ramin:80, categoria:'Industrial'   },
  { id:'ind-pes',   nombre:'Industrial pesado',         EmMin:750,  Uomin:0.5, UGRmax:19, Ramin:80, categoria:'Industrial'   },
  { id:'comercio',  nombre:'Comercio / retail',         EmMin:500,  Uomin:0.6, UGRmax:22, Ramin:90, categoria:'Comercial'    },
  { id:'hotel',     nombre:'Hotel / recepción',         EmMin:300,  Uomin:0.4, UGRmax:22, Ramin:80, categoria:'Comercial'    },
  { id:'medico',    nombre:'Área médica / examen',      EmMin:1000, Uomin:0.7, UGRmax:19, Ramin:90, categoria:'Salud'        },
  { id:'parking',   nombre:'Parking / garaje',          EmMin:75,   Uomin:0.4, UGRmax:25, Ramin:40, categoria:'Exterior'     },
]

// ── Intensidad puntual ────────────────────────────────────
function intensityPreset(p: LuminairePreset, g: number): number {
  return g >= 90 ? 0 : p.I0 * Math.pow(Math.cos(g * Math.PI / 180), p.n)
}

export function intensity(src: LightSource, gammaDeg: number, phiDeg = 0): number {
  return src.type === 'preset'
    ? intensityPreset(src.preset, gammaDeg)
    : getIntensityIES(src.ies, gammaDeg, phiDeg)
}

export function lumens(src: LightSource) { return src.type==='preset' ? src.preset.lumens : src.ies.totalFlux }
export function watts(src: LightSource)  { return src.type==='preset' ? src.preset.watts  : src.ies.inputWatts }
export function label(src: LightSource)  { return src.type==='preset' ? src.preset.nombre : src.ies.luminaireName }

export function polarDist(src: LightSource): number[] {
  return Array.from({length:91},(_,g) => intensity(src, g, 0))
}

// ── Factor interreflexiones (BK simplificado) ─────────────
function interrefl(room: Room): number {
  const { largo:a, ancho:b, alto:h, hPlan:wp, rTecho:rc, rParedes:rw, rSuelo:rf } = room
  const hm = h - wp
  const K  = (a * b) / (hm * (a + b))
  const Sm = (rc*(a*b) + rw*2*hm*(a+b) + rf*(a*b)) / (2*(a*b) + 2*hm*(a+b))
  return Math.min(1.4, Math.max(1.0, 1 / (1 - Sm * (1 - 1/(1+K)))))
}

// ── Cálculo principal (punto a punto) ─────────────────────
const GN = 60

export function calcRoom(lums: Luminaire[], room: Room, fm: number): CalcResult {
  const { largo:a, ancho:b } = room
  const hm  = room.alto - room.hPlan
  const irf = interrefl(room)
  const GR = GN, GC = GN
  const grid = new Float32Array(GR * GC)

  if (lums.length > 0) {
    for (let r = 0; r < GR; r++) {
      const py = b / (GR-1) * r
      for (let c = 0; c < GC; c++) {
        const px = a / (GC-1) * c
        let E = 0
        for (const lum of lums) {
          const dx = px - lum.x, dy = py - lum.y
          const dH = Math.sqrt(dx*dx + dy*dy)
          const dT = Math.sqrt(dH*dH + hm*hm)
          const g  = Math.atan2(dH, hm) * 180 / Math.PI
          const ph = Math.atan2(dy, dx) * 180 / Math.PI
          E += (intensity(lum.source, g, ph) / (dT*dT)) * (hm/dT) * lum.dimming
        }
        grid[r*GC+c] = E * fm * irf
      }
    }
  }

  let sum=0, mn=Infinity, mx=-Infinity
  for (let k=0; k<grid.length; k++) {
    const v=grid[k]; sum+=v
    if(v<mn) mn=v
    if(v>mx) mx=v
  }
  const Em = sum / grid.length

  const totalW  = lums.reduce((s,l) => s + watts(l.source), 0)
  const totalLm = lums.reduce((s,l) => s + lumens(l.source), 0)

  // Isolíneas
  const step = Em<200?50 : Em<600?100 : Em<2000?250:500
  const isoVals: number[] = []
  for (let v=Math.ceil((mn||0)/step)*step; v<=mx; v+=step) if(v>5) isoVals.push(v)
  const isolines = isoVals.map(val => ({ value:val, segs: marchSquares(grid,GR,GC,a,b,val) }))

  return { grid, GR, GC, Em, Emin:mn===Infinity?0:mn, Emax:mx===-Infinity?0:mx,
           Uo: Em>0 ? (mn===Infinity?0:mn)/Em : 0,
           totalW, totalLm, DPEA: totalW/(a*b), isolines }
}

// ── Marching Squares ──────────────────────────────────────
function marchSquares(
  grid: Float32Array, GR:number, GC:number, W:number, H:number, thr:number
): [number,number,number,number][] {
  const segs: [number,number,number,number][] = []
  const v  = (r:number,c:number) => grid[r*GC+c]
  const px = (c:number) => c/(GC-1)*W
  const py = (r:number) => r/(GR-1)*H
  const lp = (a:number,b:number,va:number,vb:number) => a + (b-a)*(thr-va)/(vb-va)

  for (let r=0; r<GR-1; r++) for (let c=0; c<GC-1; c++) {
    const v00=v(r,c), v10=v(r,c+1), v01=v(r+1,c), v11=v(r+1,c+1)
    const idx = (+(v00>=thr)) | ((+(v10>=thr))<<1) | ((+(v11>=thr))<<2) | ((+(v01>=thr))<<3)
    if(idx===0||idx===15) continue

    const T=[lp(px(c),px(c+1),v00,v10), py(r)  ]
    const B=[lp(px(c),px(c+1),v01,v11), py(r+1)]
    const L=[px(c),   lp(py(r),py(r+1),v00,v01)]
    const R=[px(c+1), lp(py(r),py(r+1),v10,v11)]

    const s=(a:[number,number],b:[number,number])=>segs.push([a[0],a[1],b[0],b[1]])
    switch(idx){
      case 1:case 14: s(T as any,L as any); break
      case 2:case 13: s(T as any,R as any); break
      case 3:case 12: s(L as any,R as any); break
      case 4:case 11: s(B as any,R as any); break
      case 5: s(T as any,R as any); s(B as any,L as any); break
      case 6:case 9:  s(T as any,B as any); break
      case 7:case 8:  s(B as any,L as any); break
      case 10: s(T as any,L as any); s(B as any,R as any); break
    }
  }
  return segs
}

// ── Falso color (estilo DIALux) ───────────────────────────
const CMAP: [number,number,number][] = [
  [0,0,80],[0,0,200],[0,120,255],[0,220,200],
  [0,220,0],[180,255,0],[255,255,0],[255,140,0],[255,0,0],[255,255,255]
]

export function lux2rgb(lux:number, max:number): [number,number,number] {
  const t  = Math.max(0, Math.min(1, lux / (max||1)))
  const sc = t * (CMAP.length-1)
  const lo = Math.floor(sc), hi = Math.min(CMAP.length-1, lo+1)
  const f  = sc - lo
  return [
    Math.round(CMAP[lo][0]*(1-f)+CMAP[hi][0]*f),
    Math.round(CMAP[lo][1]*(1-f)+CMAP[hi][1]*f),
    Math.round(CMAP[lo][2]*(1-f)+CMAP[hi][2]*f),
  ]
}

export function bilerp(g:Float32Array, GR:number, GC:number, nr:number, nc:number): number {
  const r=nr*(GR-1), c=nc*(GC-1)
  const r0=Math.floor(r), r1=Math.min(GR-1,r0+1)
  const c0=Math.floor(c), c1=Math.min(GC-1,c0+1)
  const dr=r-r0, dc=c-c0
  return g[r0*GC+c0]*(1-dr)*(1-dc) + g[r0*GC+c1]*(1-dr)*dc +
         g[r1*GC+c0]*dr*(1-dc)     + g[r1*GC+c1]*dr*dc
}

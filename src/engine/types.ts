// ============================================================
//  ELUX — Tipos del sistema
// ============================================================

export interface IESData {
  filename: string
  manufacturer: string
  luminaireName: string
  catalogNumber: string
  inputWatts: number
  totalFlux: number
  maxCandela: number
  efficacy: number
  vertAngles: number[]
  horizAngles: number[]
  candela: number[][]
}

export interface LuminairePreset {
  id: string
  nombre: string
  categoria: string
  lumens: number
  watts: number
  halfAngle: number
  n: number
  I0: number
}

export type LightSource =
  | { type: 'preset'; preset: LuminairePreset }
  | { type: 'ies';    ies:    IESData         }

export interface Luminaire {
  id: string
  x: number         // metros
  y: number
  source: LightSource
  dimming: number   // 0.1 – 1.0
}

export interface Room {
  largo: number     // m (X)
  ancho: number     // m (Y)
  alto: number      // m
  hPlan: number     // altura plano de trabajo
  rTecho: number    // reflectancia techo 0-1
  rParedes: number  // reflectancia paredes 0-1
  rSuelo: number    // reflectancia suelo 0-1
}

export interface SpaceNorm {
  id: string
  nombre: string
  EmMin: number
  Uomin: number
  UGRmax: number
  Ramin: number
  categoria: string
}

export interface CalcResult {
  grid: Float32Array
  GR: number
  GC: number
  Em: number
  Emin: number
  Emax: number
  Uo: number
  totalW: number
  totalLm: number
  DPEA: number
  isolines: { value: number; segs: [number,number,number,number][] }[]
}

export type Tool = 'select' | 'add' | 'delete' | 'linea' | 'circulo' | 'draw'

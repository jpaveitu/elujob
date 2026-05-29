// ============================================================
//  ELUX — Parser IES ANSI/LM-63 (1986/1991/1995/2002)
//  Basado en manuallumino + ies-render (michaellevin)
// ============================================================

import type { IESData } from './types'

export function parseIES(text: string, filename: string): IESData | null {
  try {
    const lines = text.split(/\r?\n/)

    let manufacturer  = ''
    let luminaireName = ''
    let catalogNumber = ''

    for (const line of lines) {
      const t = line.trim()
      const m = t.match(/^\[([A-Z0-9_]+)\]\s*(.*)$/)
      if (m) {
        switch (m[1]) {
          case 'MANUFAC':   manufacturer  = m[2].trim(); break
          case 'LUMCAT':    catalogNumber = m[2].trim(); break
          case 'LUMINAIRE': luminaireName = m[2].trim(); break
          case 'MORE':      break
        }
      }
    }

    const tiltIdx = lines.findIndex(l => /^TILT=/i.test(l.trim()))
    if (tiltIdx === -1) throw new Error('Sin línea TILT')

    const dataRaw = lines.slice(tiltIdx + 1).join(' ')
    const tokens  = dataRaw.trim().split(/\s+/).map(Number).filter(v => !isNaN(v))
    let i = 0
    const next = () => tokens[i++]

    next() // numLamps
    next() // lumensPerLamp
    const candelaMultiplier = next()
    const numV              = next()
    const numH              = next()
    next() // photoType
    next() // unitsType
    next() // lumWidth
    next() // lumLength
    next() // lumHeight

    const ballastFactor     = next()
    const ballastLampFactor = next()
    const inputWatts        = next()
    const bfTotal = ballastFactor * ballastLampFactor

    const vertAngles: number[] = []
    for (let j = 0; j < numV; j++) vertAngles.push(next())

    const horizAngles: number[] = []
    for (let j = 0; j < numH; j++) horizAngles.push(next())

    const candela: number[][] = []
    for (let h = 0; h < numH; h++) {
      const plane: number[] = []
      for (let v = 0; v < numV; v++)
        plane.push(next() * candelaMultiplier * bfTotal)
      candela.push(plane)
    }

    // Flujo total — integración numérica zonal
    let totalFlux = 0
    if (numH <= 1) {
      for (let v = 0; v < numV - 1; v++) {
        const g1 = (vertAngles[v]   * Math.PI) / 180
        const g2 = (vertAngles[v+1] * Math.PI) / 180
        const I1 = candela[0][v], I2 = candela[0][v+1]
        totalFlux += Math.PI * (I1 * Math.sin(g1) + I2 * Math.sin(g2)) * (g2 - g1)
      }
    } else {
      for (let h = 0; h < numH - 1; h++) {
        const dp = ((horizAngles[h+1] - horizAngles[h]) * Math.PI) / 180
        for (let v = 0; v < numV - 1; v++) {
          const g1 = (vertAngles[v]   * Math.PI) / 180
          const g2 = (vertAngles[v+1] * Math.PI) / 180
          const Iavg = (candela[h][v] + candela[h][v+1] + candela[h+1][v] + candela[h+1][v+1]) / 4
          totalFlux += Iavg * ((Math.sin(g1) + Math.sin(g2)) / 2) * (g2 - g1) * dp
        }
      }
    }

    const maxCandela = Math.max(...candela.flat())
    const efficacy   = inputWatts > 0 ? totalFlux / inputWatts : 0

    return {
      filename, manufacturer: manufacturer || '—',
      luminaireName: luminaireName || filename.replace(/\.ies$/i, ''),
      catalogNumber: catalogNumber || '—',
      inputWatts,
      vertAngles, horizAngles, candela,
      totalFlux, maxCandela, efficacy,
    }
  } catch (err) {
    console.error('[IES Parser]', err)
    return null
  }
}

export function getIntensityIES(data: IESData, gammaDeg: number, phiDeg = 0): number {
  const { vertAngles: VA, horizAngles: HA, candela } = data
  if (gammaDeg < VA[0] || gammaDeg > VA[VA.length - 1]) return 0

  let h0 = 0, h1 = 0, ht = 0
  if (HA.length > 1) {
    const maxH = HA[HA.length - 1]
    let phi = ((phiDeg % 360) + 360) % 360
    if (maxH <= 90)        phi = phi % 90
    else if (maxH <= 180)  phi = phi % 180
    phi = Math.max(HA[0], Math.min(maxH, phi))
    for (let j = 0; j < HA.length - 1; j++) {
      if (phi >= HA[j] && phi <= HA[j + 1]) {
        h0 = j; h1 = j + 1
        ht = (phi - HA[j]) / (HA[j + 1] - HA[j])
        break
      }
    }
  }

  let v0 = 0, v1 = 0, vt = 0
  for (let j = 0; j < VA.length - 1; j++) {
    if (gammaDeg >= VA[j] && gammaDeg <= VA[j + 1]) {
      v0 = j; v1 = j + 1
      vt = (gammaDeg - VA[j]) / (VA[j + 1] - VA[j])
      break
    }
  }

  if (h0 === h1) return candela[h0][v0] * (1 - vt) + candela[h0][v1] * vt
  const Iv0 = candela[h0][v0] * (1 - ht) + candela[h1][v0] * ht
  const Iv1 = candela[h0][v1] * (1 - ht) + candela[h1][v1] * ht
  return Iv0 * (1 - vt) + Iv1 * vt
}

export function getCandelaDistributionIES(data: IESData): number[] {
  return Array.from({ length: 91 }, (_, g) => getIntensityIES(data, g, 0))
}

export type { IESData }

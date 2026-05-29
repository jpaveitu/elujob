// ============================================================
//  ELUX — Parser DXF ligero (LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC)
//  Sin dependencias externas. Renderiza en canvas → data URL
// ============================================================

type Seg = [number, number, number, number]  // x1 y1 x2 y2

export function dxfToDataURL(text: string, W = 1600, H = 1200): string | null {
  const segs = extractSegments(text)
  if (segs.length === 0) return null
  return renderSegments(segs, W, H)
}

function extractSegments(text: string): Seg[] {
  const lines = text.split(/\r?\n/)
  const segs: Seg[] = []
  let i = 0
  let inEntities = false

  while (i < lines.length - 1) {
    const code = parseInt(lines[i].trim())
    const val  = lines[i + 1]?.trim() ?? ''
    i += 2

    if (isNaN(code)) continue
    if (val === 'ENTITIES') { inEntities = true;  continue }
    if (val === 'ENDSEC')   { inEntities = false; continue }
    if (!inEntities || code !== 0) continue

    // ── LINE ──────────────────────────────────────────────
    if (val === 'LINE') {
      let x1=0,y1=0,x2=0,y2=0
      while (i < lines.length - 1) {
        const c = parseInt(lines[i].trim())
        if (c === 0) break
        const v = parseFloat(lines[i+1].trim())
        i += 2
        if (c === 10) x1=v; else if (c === 20) y1=v
        else if (c === 11) x2=v; else if (c === 21) y2=v
      }
      segs.push([x1,y1,x2,y2])
    }

    // ── LWPOLYLINE ────────────────────────────────────────
    else if (val === 'LWPOLYLINE') {
      const xs: number[] = [], ys: number[] = []
      let closed = false
      while (i < lines.length - 1) {
        const c = parseInt(lines[i].trim())
        if (c === 0) break
        const v = parseFloat(lines[i+1].trim())
        i += 2
        if (c === 70) closed = (v & 1) === 1
        else if (c === 10) xs.push(v)
        else if (c === 20) ys.push(v)
      }
      const n = Math.min(xs.length, ys.length)
      for (let k = 0; k < n - 1; k++) segs.push([xs[k],ys[k],xs[k+1],ys[k+1]])
      if (closed && n > 1)            segs.push([xs[n-1],ys[n-1],xs[0],ys[0]])
    }

    // ── POLYLINE ──────────────────────────────────────────
    else if (val === 'POLYLINE') {
      const pts: {x:number,y:number}[] = []
      let closed = false
      while (i < lines.length - 1) {
        const c  = parseInt(lines[i].trim())
        const sv = lines[i+1]?.trim() ?? ''
        i += 2
        if (c === 70) closed = (parseInt(sv) & 1) === 1
        if (c === 0 && sv === 'VERTEX') {
          let vx=0, vy=0
          while (i < lines.length - 1) {
            const vc = parseInt(lines[i].trim())
            if (vc === 0) break
            const vv = parseFloat(lines[i+1].trim())
            i += 2
            if (vc === 10) vx=vv; else if (vc === 20) vy=vv
          }
          pts.push({x:vx,y:vy})
        }
        if (c === 0 && sv === 'SEQEND') break
      }
      for (let k = 0; k < pts.length - 1; k++) segs.push([pts[k].x,pts[k].y,pts[k+1].x,pts[k+1].y])
      if (closed && pts.length > 1) segs.push([pts[pts.length-1].x,pts[pts.length-1].y,pts[0].x,pts[0].y])
    }

    // ── CIRCLE ────────────────────────────────────────────
    else if (val === 'CIRCLE') {
      let cx=0,cy=0,r=0
      while (i < lines.length - 1) {
        const c = parseInt(lines[i].trim())
        if (c === 0) break
        const v = parseFloat(lines[i+1].trim())
        i += 2
        if (c === 10) cx=v; else if (c === 20) cy=v; else if (c === 40) r=v
      }
      const N = 48
      for (let k = 0; k < N; k++) {
        const a1=(k/N)*Math.PI*2, a2=((k+1)/N)*Math.PI*2
        segs.push([cx+r*Math.cos(a1),cy+r*Math.sin(a1),cx+r*Math.cos(a2),cy+r*Math.sin(a2)])
      }
    }

    // ── ARC ───────────────────────────────────────────────
    else if (val === 'ARC') {
      let cx=0,cy=0,r=0,a1=0,a2=360
      while (i < lines.length - 1) {
        const c = parseInt(lines[i].trim())
        if (c === 0) break
        const v = parseFloat(lines[i+1].trim())
        i += 2
        if (c === 10) cx=v; else if (c === 20) cy=v; else if (c === 40) r=v
        else if (c === 50) a1=v; else if (c === 51) a2=v
      }
      const start = a1*Math.PI/180, end = a2<a1?a2*Math.PI/180+Math.PI*2:a2*Math.PI/180
      const N = Math.max(8, Math.round((end-start)/(Math.PI/16)))
      for (let k = 0; k < N; k++) {
        const t1=start+(k/N)*(end-start), t2=start+((k+1)/N)*(end-start)
        segs.push([cx+r*Math.cos(t1),cy+r*Math.sin(t1),cx+r*Math.cos(t2),cy+r*Math.sin(t2)])
      }
    }
  }

  return segs
}

function renderSegments(segs: Seg[], W: number, H: number): string {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity
  for (const [x1,y1,x2,y2] of segs) {
    minX=Math.min(minX,x1,x2); maxX=Math.max(maxX,x1,x2)
    minY=Math.min(minY,y1,y2); maxY=Math.max(maxY,y1,y2)
  }
  const dW=maxX-minX||1, dH=maxY-minY||1
  const scale = Math.min(W*0.92/dW, H*0.92/dH)
  const offX  = W/2 - (minX+dW/2)*scale
  const offY  = H/2 + (minY+dH/2)*scale  // flip Y

  const cv = document.createElement('canvas')
  cv.width=W; cv.height=H
  const ctx = cv.getContext('2d')!
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,W,H)
  ctx.strokeStyle='#1a2a4a'; ctx.lineWidth=1.2; ctx.lineCap='round'

  for (const [x1,y1,x2,y2] of segs) {
    ctx.beginPath()
    ctx.moveTo(x1*scale+offX, offY-y1*scale)
    ctx.lineTo(x2*scale+offX, offY-y2*scale)
    ctx.stroke()
  }
  return cv.toDataURL('image/png')
}

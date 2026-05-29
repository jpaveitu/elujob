import { useState, useEffect, useRef, useCallback, useReducer } from 'react'
import { parseIES, getCandelaDistributionIES } from '../engine/iesParser'
import { LUMINAIRES as PRESETS, SPACE_TYPES as NORMAS, calculateLighting as calcRoom, luxToRGB as lux2rgb, bilinearSample as bilerp, getCandelaDistribution as polarDist, sourceName as label, sourceLumens as lumens, sourceWatts as watts } from '../engine/lightingEngine'
import { dxfToDataURL } from '../engine/dxfParser'
import type { Luminaire, Room, CalcResult, LightSource, Tool } from '../engine/types'

// ── Paleta UI — estilo Dialux EVO ──────────────────────────
const P = {
  bg:'#2d3035',    panel:'#404346',  border:'#2d2f31',
  az:'#2563eb',    azL:'#60a5fa',    azF:'rgba(37,99,235,0.18)',
  gr:'#3b82f6',    grF:'rgba(59,130,246,0.15)', grB:'rgba(59,130,246,0.4)',
  rd:'#64748b',    rdF:'rgba(100,116,139,0.15)', rdB:'rgba(100,116,139,0.4)',
  am:'#93c5fd',    tx:'#e8e8e8',     mu:'#9a9a9a',  mu2:'#c8c8c8',
  canvas:'#3f4349',
  // Dialux panel específico
  panelSec:'#3a3d40',   // fondo strip sección
  panelTx:'#ffffff',    // texto activo
  panelMu:'#ffffff',    // label/muted
  panelDis:'#ffffff',   // deshabilitado
}

// CMAP colores para leyenda
const CMAP: [number,number,number][] = [
  [0,0,80],[0,0,200],[0,120,255],[0,220,200],
  [0,220,0],[180,255,0],[255,255,0],[255,140,0],[255,0,0],[255,255,255]
]
const GRAD = CMAP.map((c,i)=>`rgb(${c[0]},${c[1]},${c[2]}) ${(i/(CMAP.length-1)*100).toFixed(1)}%`).join(',')

// ── Color → reflectancia (luminancia CIE) ─────────────────
function hexToRefl(hex: string): number {
  const r=parseInt(hex.slice(1,3),16)/255
  const g=parseInt(hex.slice(3,5),16)/255
  const b=parseInt(hex.slice(5,7),16)/255
  return Math.round((0.2126*r+0.7152*g+0.0722*b)*100)/100
}

// ── Biblioteca local IES ──────────────────────────────────
interface LibraryItem {
  id: string; filename: string; manufacturer: string; luminaireName: string
  totalFlux: number; inputWatts: number; efficacy: number; maxCandela: number
  uploadDate: string; rawText: string; polarPoints: number[]
}
const LIB_KEY = 'elux_library'
function useLibrary() {
  const [items, setItems] = useState<LibraryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(LIB_KEY) ?? '[]') } catch { return [] }
  })
  const add = (item: LibraryItem) => {
    const next = [item, ...items.filter(i => i.id !== item.id)]
    localStorage.setItem(LIB_KEY, JSON.stringify(next)); setItems(next)
  }
  const remove = (id: string) => {
    const next = items.filter(i => i.id !== id)
    localStorage.setItem(LIB_KEY, JSON.stringify(next)); setItems(next)
  }
  return { items, add, remove }
}

// ── Mini polar (para lista de biblioteca) ─────────────────
function MiniPolar({ pts, size = 56 }: { pts: number[], size?: number }) {
  const cx = size / 2, cy = size / 2, R = size / 2 - 4
  const maxI = Math.max(...pts) || 1
  const r1 = Array.from({ length: 91 }, (_, g) => {
    const i = pts[g] / maxI * R, rad = g * Math.PI / 180
    return `${cx + i * Math.sin(rad)},${cy + i * Math.cos(rad)}`
  })
  const r2 = Array.from({ length: 91 }, (_, g) => {
    const i = pts[g] / maxI * R, rad = g * Math.PI / 180
    return `${cx - i * Math.sin(rad)},${cy + i * Math.cos(rad)}`
  })
  const path = `M ${r1.join(' L ')} L ${[...r2].reverse().join(' L ')} Z`
  return (
    <svg width={size} height={size} style={{ display:'block', flexShrink:0 }}>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#1a2336" strokeWidth={0.8}/>
      <circle cx={cx} cy={cy} r={R*0.5} fill="none" stroke="#1a2336" strokeWidth={0.5}/>
      <path d={path} fill="rgba(37,99,235,0.22)" stroke="#2563eb" strokeWidth={1.2}/>
      <circle cx={cx} cy={cy} r={2} fill="#60a5fa"/>
    </svg>
  )
}

// ── Estado ────────────────────────────────────────────────
interface S {
  room: Room
  lums: Luminaire[]
  normaId: string
  fm: number
  nombre: string
}
type A =
  | { t:'ROOM'; p: Partial<Room> }
  | { t:'ADD';  l: Luminaire }
  | { t:'MOVE'; id:string; x:number; y:number }
  | { t:'DEL';  id:string }
  | { t:'DIM';  id:string; v:number }
  | { t:'NORMA'; id:string }
  | { t:'FM';   v:number }
  | { t:'NOMBRE'; v:string }
  | { t:'CLEAR' }

const init: S = {
  room:{ largo:10, ancho:8, alto:3.5, hPlan:0.85, rTecho:0.7, rParedes:0.5, rSuelo:0.2 },
  lums:[], normaId:'oficina', fm:0.80, nombre:''
}
function red(s:S, a:A): S {
  switch(a.t){
    case 'ROOM':  return {...s, room:{...s.room,...a.p}}
    case 'ADD':   return {...s, lums:[...s.lums, a.l]}
    case 'MOVE':  return {...s, lums:s.lums.map(l=>l.id===a.id?{...l,x:a.x,y:a.y}:l)}
    case 'DEL':   return {...s, lums:s.lums.filter(l=>l.id!==a.id)}
    case 'DIM':   return {...s, lums:s.lums.map(l=>l.id===a.id?{...l,dimming:a.v}:l)}
    case 'NORMA': return {...s, normaId:a.id}
    case 'FM':    return {...s, fm:a.v}
    case 'NOMBRE':return {...s, nombre:a.v}
    case 'CLEAR': return {...s, lums:[]}
    default:      return s
  }
}

// ── Num input ─────────────────────────────────────────────
function Num({label:lb,unit,value,onChange,min,max,step}:{label:string;unit?:string;value:number;onChange:(v:number)=>void;min?:number;max?:number;step?:number}){
  return(
    <div style={{marginBottom:'0.5rem'}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:'0.18rem'}}>
        <span style={{fontSize:'0.7rem',color:P.mu2}}>{lb}</span>
        {unit&&<span style={{fontSize:'0.65rem',color:P.azL}}>{unit}</span>}
      </div>
      <input type="number" value={value} min={min} max={max} step={step??'any'}
        onChange={e=>onChange(+e.target.value)}
        style={{width:'100%',background:'#050810',border:`1px solid ${P.border}`,color:P.tx,
          padding:'0.32rem 0.5rem',borderRadius:'5px',fontSize:'0.83rem',outline:'none'}}
        onFocus={e=>e.target.style.borderColor=P.az}
        onBlur={e=>e.target.style.borderColor=P.border}/>
    </div>
  )
}

// ── Blk ───────────────────────────────────────────────────
function Blk({title,icon,children}:{title:string;icon?:string;children:React.ReactNode}){
  return(
    <div style={{marginBottom:'0.9rem'}}>
      <p style={{fontSize:'0.62rem',fontWeight:700,color:P.mu,textTransform:'uppercase',
        letterSpacing:'0.08em',marginBottom:'0.5rem',display:'flex',gap:'0.3rem',alignItems:'center'}}>
        {icon&&<i className={`bi ${icon}`} style={{color:P.azL}}/>}{title}
      </p>
      {children}
    </div>
  )
}

// ── Selector de color de superficie ──────────────────────
interface SurfaceColorProps {
  label: string
  hex: string
  refl: number
  swatches: {hex:string; name:string}[]
  onChange: (hex:string, refl:number) => void
}
function SurfaceColor({label:lb, hex, refl, swatches, onChange}: SurfaceColorProps){
  return(
    <div style={{marginBottom:'0.65rem'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'0.25rem'}}>
        <span style={{fontSize:'0.68rem',color:P.mu2}}>{lb}</span>
        <div style={{display:'flex',alignItems:'center',gap:'0.4rem'}}>
          <span style={{fontSize:'0.62rem',color:P.azL}}>{Math.round(refl*100)}%</span>
          {/* color picker libre */}
          <label style={{cursor:'pointer',position:'relative'}}>
            <input type="color" value={hex}
              onChange={e=>onChange(e.target.value, hexToRefl(e.target.value))}
              style={{opacity:0,position:'absolute',width:'100%',height:'100%',cursor:'pointer'}}/>
            <div style={{width:'20px',height:'20px',borderRadius:'4px',
              background:hex,border:`2px solid ${P.border}`,cursor:'pointer'}}/>
          </label>
        </div>
      </div>
      {/* paleta de tonos */}
      <div style={{display:'flex',flexWrap:'wrap',gap:'0.2rem'}}>
        {swatches.map(sw=>(
          <button key={sw.hex} title={`${sw.name} (${Math.round(hexToRefl(sw.hex)*100)}%)`}
            onClick={()=>onChange(sw.hex, hexToRefl(sw.hex))}
            style={{width:'22px',height:'22px',borderRadius:'4px',cursor:'pointer',padding:0,
              background:sw.hex,
              border:`2px solid ${hex===sw.hex?'#60a5fa':'rgba(255,255,255,0.12)'}`,
              boxShadow:hex===sw.hex?`0 0 0 1px #2563eb`:undefined}}>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Diagrama polar  (0° = nadir = ABAJO) ─────────────────
function Polar({src}:{src:LightSource}){
  const dist=polarDist(src)
  const S=200, cx=S/2, cy=S/2-18   // cy desplazado arriba → distribución usa mitad inferior
  const R=S/2-14
  const maxI=Math.max(...dist)||1

  // 0° en la parte INFERIOR: usar +cos en lugar de -cos
  const pts=(side:1|-1)=>Array.from({length:91},(_,g)=>{
    const i=dist[g]/maxI*R, rad=g*Math.PI/180
    return `${cx+side*i*Math.sin(rad)},${cy+i*Math.cos(rad)}`
  })
  const path=`M ${pts(1).join(' L ')} L ${[...pts(-1)].reverse().join(' L ')} Z`

  // líneas guía de ángulos (hacia abajo)
  const guideAngles=[30,60,90]

  return(
    <div style={{
      borderRadius:'8px', marginBottom:'0.7rem',
      background:'linear-gradient(160deg,#060a14 0%,#070c18 100%)',
      border:'1px solid #1e2d45', padding:'0.6rem 0.5rem 0.4rem',
    }}>
      <svg width={S} height={S} style={{display:'block',margin:'0 auto'}}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <radialGradient id="fillGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.18"/>
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.03"/>
          </radialGradient>
        </defs>

        {/* círculos de referencia */}
        {[1, 0.5].map(f=>(
          <circle key={f} cx={cx} cy={cy} r={f*R}
            fill="none" stroke="#1e2d45" strokeWidth={f===1?0.8:0.5}
            strokeDasharray={f===1?undefined:'3,4'}/>
        ))}

        {/* ejes cruzados */}
        <line x1={cx} y1={cy-R-2} x2={cx} y2={cy+R+2} stroke="#1a2a3e" strokeWidth={0.6}/>
        <line x1={cx-R-2} y1={cy} x2={cx+R+2} y2={cy} stroke="#1a2a3e" strokeWidth={0.6}/>

        {/* curva — relleno degradado + línea con glow */}
        <path d={path} fill="url(#fillGrad)"/>
        <path d={path} fill="none" stroke="#3b82f6" strokeWidth={1.4} filter="url(#glow)"/>

        {/* punto central */}
        <circle cx={cx} cy={cy} r={2.5} fill="#1d4ed8" stroke="#60a5fa" strokeWidth={0.8}/>

        {/* etiquetas γ — tipografía fina */}
        <text x={cx+R+5} y={cy+3} fontSize={6.5} fill="#475569" fontFamily="Inter,sans-serif">90°</text>
        <text x={cx-R-5} y={cy+3} fontSize={6.5} fill="#475569" fontFamily="Inter,sans-serif" textAnchor="end">270°</text>
        <text x={cx-3} y={cy+R+11} fontSize={6.5} fill="#60a5fa" fontFamily="Inter,sans-serif" textAnchor="middle">0°</text>
        <text x={cx-3} y={cy-R-5} fontSize={6.5} fill="#475569" fontFamily="Inter,sans-serif" textAnchor="middle">180°</text>
      </svg>
    </div>
  )
}

// ── Ficha técnica fotométrica ─────────────────────────────
function FichaFotometrica({ src }: { src: LightSource }) {
  const dist = polarDist(src)
  const maxI  = Math.max(...dist) || 1

  // Ángulo de haz (50% Imax) y campo (10% Imax) — búsqueda desde 0°
  let beamHalf = 90, fieldHalf = 90
  for (let g = 0; g <= 90; g++) {
    if (dist[g] / maxI < 0.5 && beamHalf  === 90) { beamHalf  = g; }
    if (dist[g] / maxI < 0.1 && fieldHalf === 90) { fieldHalf = g; }
  }

  const isIES = src.type === 'ies' && src.ies
  const d = isIES ? src.ies! : null

  // Métricas principales
  const flux = d ? Math.round(d.totalFlux) : Math.round(lumens(src))
  const w    = d ? d.inputWatts : watts(src)
  const eff  = d ? d.efficacy.toFixed(1) : (w > 0 ? (flux / w).toFixed(1) : '—')
  const imax = Math.round(maxI)

  // Tipo de distribución estimado
  const ratioNadir = dist[0] / maxI
  const tipoDesc =
    ratioNadir > 0.9  ? 'Directa concentrada' :
    ratioNadir > 0.6  ? 'Directa amplia'       :
    ratioNadir > 0.3  ? 'Semi-directa'          :
    ratioNadir > 0.05 ? 'General difusa'         : 'Indirecta'

  return (
    <div style={{ marginBottom:'0.9rem' }}>
      {/* Cabecera: fabricante + nombre + catálogo */}
      {d && (
        <div style={{ background:'#070b14', border:`1px solid ${P.border}`, borderRadius:'6px',
          padding:'0.45rem 0.55rem', marginBottom:'0.5rem' }}>
          <p style={{ fontSize:'0.57rem', color:P.mu, margin:0, marginBottom:'0.08rem',
            textTransform:'uppercase', letterSpacing:'0.05em' }}>{d.manufacturer}</p>
          <p style={{ fontSize:'0.7rem', color:P.tx, fontWeight:700, margin:0,
            lineHeight:1.25, marginBottom:'0.12rem' }}>{d.luminaireName}</p>
          {d.catalogNumber !== '—' && (
            <p style={{ fontSize:'0.58rem', color:P.azL, margin:0 }}>
              <i className="bi bi-tag me-1"/>{d.catalogNumber}
            </p>
          )}
          <p style={{ fontSize:'0.56rem', color:P.mu, margin:0, marginTop:'0.1rem' }}>
            <i className="bi bi-file-earmark-bar-graph me-1"/>{d.filename}
          </p>
        </div>
      )}

      {/* KPIs: 2×3 grid */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0.22rem', marginBottom:'0.5rem' }}>
        {([
          ['Flujo total',   `${flux.toLocaleString()} lm`, P.azL ],
          ['Potencia',      `${w} W`,                       P.azL ],
          ['Eficacia',      `${eff} lm/W`,                  P.gr  ],
          ['I máx',         `${imax.toLocaleString()} cd`,  P.azL ],
          ['Ángulo haz',    beamHalf<90 ? `${beamHalf*2}°` : '>180°', P.am ],
          ['Ángulo campo',  fieldHalf<90 ? `${fieldHalf*2}°` : '>180°', P.mu2],
        ] as [string,string,string][]).map(([k, v, col]) => (
          <div key={k} style={{ background:'#060a14', border:`1px solid ${P.border}`,
            borderRadius:'5px', padding:'0.28rem 0.4rem' }}>
            <p style={{ fontSize:'0.52rem', color:P.mu, margin:0, marginBottom:'0.06rem' }}>{k}</p>
            <p style={{ fontSize:'0.72rem', color:col, fontWeight:700, margin:0 }}>{v}</p>
          </div>
        ))}
      </div>


    </div>
  )
}

// ── Leyenda de falso color ────────────────────────────────
function ColorLegend({emax, width}: {emax:number, width:number}){
  const ticks=CMAP.map((_,i)=>({
    pct: i/(CMAP.length-1),
    lux: Math.round((i/(CMAP.length-1))*emax),
    color:`rgb(${CMAP[i][0]},${CMAP[i][1]},${CMAP[i][2]})`
  }))
  return(
    <div style={{width:width+'px', paddingTop:'0.3rem'}}>
      <div style={{height:'14px',borderRadius:'4px',
        background:`linear-gradient(to right,${GRAD})`,border:`1px solid ${P.border}`}}/>
      <div style={{position:'relative',height:'34px',marginTop:'2px'}}>
        {ticks.filter((_,i)=>i%2===0||i===9).map(tk=>(
          <div key={tk.pct} style={{position:'absolute',left:`${tk.pct*100}%`,
            transform:'translateX(-50%)',textAlign:'center'}}>
            <div style={{width:'1px',height:'4px',background:P.border,margin:'0 auto'}}/>
            <div style={{fontSize:'0.52rem',color:P.mu,whiteSpace:'nowrap',marginTop:'1px'}}>{tk.lux}</div>
            <div style={{width:'7px',height:'7px',borderRadius:'50%',
              background:tk.color,border:`1px solid ${P.border}`,margin:'1px auto 0'}}/>
          </div>
        ))}
      </div>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.55rem',color:P.mu,marginTop:'1px'}}>
        <span>0 lux</span>
        <span style={{color:P.mu2,fontWeight:600}}>Iluminancia horizontal — lux</span>
        <span>{emax} lux</span>
      </div>
    </div>
  )
}

// ── Constantes isométricas ────────────────────────────────
const COS30 = Math.cos(Math.PI / 6)
const SIN30 = Math.sin(Math.PI / 6)

// ── Vista 3D isométrica ───────────────────────────────────
const CW3D = 820, CH3D = 460

function Iso3D({ room, lums, result, wallHex, ceilHex, floorHex }: {
  room: Room; lums: Luminaire[]; result: CalcResult | null
  wallHex: string; ceilHex: string; floorHex: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current; if (!cv) return
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, CW3D, CH3D)

    const { largo, ancho, alto } = room

    // Escala automática para que el recinto quepa en el canvas
    const scale = Math.min(
      CW3D * 0.82 / ((largo + ancho) * COS30),
      CH3D * 0.80 / (alto + (largo + ancho) * SIN30)
    )
    const origX = CW3D / 2
    const origY = CH3D * 0.93 - (largo + ancho) * SIN30 * scale

    // Proyección isométrica: x→derecha, y→izquierda, z→arriba
    const pt = (x: number, y: number, z: number): [number, number] => [
      (x - y) * COS30 * scale + origX,
      ((x + y) * SIN30 - z) * scale + origY
    ]

    // 8 esquinas del recinto
    const [a,b,c,d,e,f,g,h] = [
      pt(0,0,0),     pt(largo,0,0),     pt(largo,ancho,0), pt(0,ancho,0),
      pt(0,0,alto),  pt(largo,0,alto),  pt(largo,ancho,alto), pt(0,ancho,alto)
    ]

    // Rellena polígono
    const fill = (pts:[number,number][], color:string) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1])
      for(const p of pts.slice(1)) ctx.lineTo(p[0],p[1])
      ctx.closePath(); ctx.fillStyle=color; ctx.fill()
    }

    // ── Fondo ────────────────────────────────────────────
    ctx.fillStyle='#080c18'; ctx.fillRect(0,0,CW3D,CH3D)

    // ── SUELO con heatmap proyectado ─────────────────────
    if (result && result.Emax > 0) {
      // Renderizar heatmap en canvas temporal
      const tmp = document.createElement('canvas')
      tmp.width = result.GC; tmp.height = result.GR
      const tc = tmp.getContext('2d')!
      const id = tc.createImageData(result.GC, result.GR)
      for (let r = 0; r < result.GR; r++) for (let c2 = 0; c2 < result.GC; c2++) {
        const lx = result.grid[r * result.GC + c2]
        const [rr,gg,bb] = lux2rgb(lx, result.Emax * 1.05)
        const i = (r * result.GC + c2) * 4
        id.data[i]=rr; id.data[i+1]=gg; id.data[i+2]=bb; id.data[i+3]=255
      }
      tc.putImageData(id, 0, 0)
      // Proyectar imagen rectangular → paralelograma del suelo
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1])
      ctx.lineTo(c[0],c[1]); ctx.lineTo(d[0],d[1]); ctx.closePath(); ctx.clip()
      ctx.setTransform(
        (b[0]-a[0])/result.GC, (b[1]-a[1])/result.GC,
        (d[0]-a[0])/result.GR, (d[1]-a[1])/result.GR,
        a[0], a[1]
      )
      ctx.drawImage(tmp, 0, 0)
      ctx.restore()
    } else {
      fill([a,b,c,d], floorHex + 'dd')
    }

    // ── PARED IZQUIERDA (y=ancho) ─────────────────────────
    fill([d,c,g,h], wallHex + 'cc')
    fill([d,c,g,h], 'rgba(0,0,0,0.22)')   // sombra

    // ── PARED DERECHA (x=largo) ───────────────────────────
    fill([b,c,g,f], wallHex + 'e0')
    fill([b,c,g,f], 'rgba(255,255,255,0.06)')  // luz suave

    // ── TECHO ─────────────────────────────────────────────
    fill([e,f,g,h], ceilHex + '90')

    // ── LÍNEAS ESTRUCTURALES ──────────────────────────────
    const edges: [[number,number],[number,number]][] = [
      [a,b],[b,c],[c,d],[d,a],          // suelo
      [e,f],[f,g],[g,h],[h,e],          // techo
      [a,e],[b,f],[c,g],[d,h]           // verticales
    ]
    ctx.strokeStyle='rgba(15,30,70,0.7)'; ctx.lineWidth=1.4; ctx.setLineDash([])
    for(const [p1,p2] of edges){
      ctx.beginPath(); ctx.moveTo(p1[0],p1[1]); ctx.lineTo(p2[0],p2[1]); ctx.stroke()
    }

    // ── LUMINARIAS ────────────────────────────────────────
    for(const lum of lums){
      const [lx,ly] = pt(lum.x, lum.y, alto)   // posición en techo
      const [fx,fy] = pt(lum.x, lum.y, 0)       // punto en suelo

      // Ángulo medio del preset (semikángulo → radio del cono en suelo)
      const pd = polarDist(lum.source)
      const maxI = Math.max(...pd) || 1
      // Estimar apertura del haz: ángulo donde intensidad cae a 50%
      let halfAngleDeg = 30
      for(let g2=0;g2<90;g2++) if(pd[g2]/maxI < 0.5){halfAngleDeg=g2;break}
      const coneR = alto * Math.tan(halfAngleDeg * Math.PI/180) * scale * 0.85

      // Cono de luz (translúcido)
      const leftF = pt(lum.x - coneR/scale, lum.y, 0)
      const rightF = pt(lum.x + coneR/scale, lum.y, 0)
      ctx.beginPath()
      ctx.moveTo(lx,ly); ctx.lineTo(leftF[0],leftF[1]); ctx.lineTo(rightF[0],rightF[1])
      ctx.closePath(); ctx.fillStyle='rgba(255,245,130,0.07)'; ctx.fill()

      // Línea vertical punteada
      ctx.beginPath(); ctx.moveTo(lx,ly); ctx.lineTo(fx,fy)
      ctx.strokeStyle='rgba(255,245,130,0.25)'; ctx.lineWidth=0.8
      ctx.setLineDash([3,4]); ctx.stroke(); ctx.setLineDash([])

      // Disco en techo (luminaria)
      const grd=ctx.createRadialGradient(lx,ly,0,lx,ly,14)
      grd.addColorStop(0,'rgba(255,245,130,0.7)')
      grd.addColorStop(1,'rgba(255,245,130,0)')
      ctx.beginPath(); ctx.arc(lx,ly,14,0,Math.PI*2)
      ctx.fillStyle=grd; ctx.fill()
      ctx.beginPath(); ctx.arc(lx,ly,4,0,Math.PI*2)
      ctx.fillStyle='#fef08a'; ctx.fill()
      ctx.strokeStyle='#fbbf24'; ctx.lineWidth=1.5; ctx.stroke()
    }

    // ── COTAS ────────────────────────────────────────────
    ctx.font='bold 11px monospace'; ctx.fillStyle='rgba(148,163,184,0.85)'
    const ma=[((a[0]+b[0])/2)+4, ((a[1]+b[1])/2)+13]
    const md=[((a[0]+d[0])/2)-38, ((a[1]+d[1])/2)+13]
    const me=[a[0]-40, (a[1]+e[1])/2]
    ctx.fillText(`${largo} m`, ma[0], ma[1])
    ctx.fillText(`${ancho} m`, md[0], md[1])
    ctx.fillText(`${alto} m`, me[0], me[1])

    // ── NORTE (orientación) ───────────────────────────────
    ctx.font='9px monospace'; ctx.fillStyle='rgba(100,116,139,0.7)'
    ctx.fillText('X →', CW3D-44, CH3D-8)
    ctx.fillText('← Y', 4, CH3D-8)

  },[room,lums,result,wallHex,ceilHex,floorHex])

  return(
    <canvas ref={ref} width={CW3D} height={CH3D}
      style={{display:'block',borderRadius:'4px',background:'#080c18'}}/>
  )
}

// ── Canvas principal ──────────────────────────────────────
const CW = 820
function Canvas({room,lums,result,tool,selId,opts,bgImgEl,bgOpacity,wallHex,ceilHex,floorHex,
  lineN,circN,circR,vertices,
  onAdd,onMove,onSel,onDel,onAutoLinea,onAutoCirculo,onAddVertex}:{
  room:Room; lums:Luminaire[]; result:CalcResult|null; tool:Tool; selId:string|null
  opts:{heat:boolean;iso:boolean;grid:boolean;vals:boolean;plan:boolean}
  bgImgEl:HTMLImageElement|null; bgOpacity:number
  wallHex:string; ceilHex:string; floorHex:string
  lineN:number; circN:number; circR:number
  vertices:{x:number,y:number}[]
  onAdd:(x:number,y:number)=>void; onMove:(id:string,x:number,y:number)=>void
  onSel:(id:string|null)=>void; onDel:(id:string)=>void
  onAutoLinea:(x1:number,y1:number,x2:number,y2:number)=>void
  onAutoCirculo:(cx:number,cy:number)=>void
  onAddVertex:(x:number,y:number)=>void
}){
  const hRef=useRef<HTMLCanvasElement>(null)
  const uRef=useRef<HTMLCanvasElement>(null)
  const pvRef=useRef<HTMLCanvasElement>(null)   // preview canvas
  const sc=CW/room.largo
  const CH=Math.round(CW*room.ancho/room.largo)
  const drag=useRef<{id:string;ox:number;oy:number}|null>(null)
  const lineStart=useRef<{x:number;y:number}|null>(null)

  // Heatmap + plano fondo
  useEffect(()=>{
    const cv=hRef.current; if(!cv) return
    const ctx=cv.getContext('2d')!
    // fondo negro
    ctx.fillStyle='#0a0c10'
    ctx.fillRect(0,0,CW,CH)
    // cuadrícula a cada metro
    ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=0.5; ctx.setLineDash([])
    for(let x=sc;x<CW;x+=sc){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,CH);ctx.stroke()}
    for(let y=sc;y<CH;y+=sc){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(CW,y);ctx.stroke()}
    // etiquetas de metros
    ctx.fillStyle='rgba(255,255,255,0.25)'; ctx.font='9px Inter,sans-serif'
    for(let m=1;m<room.largo;m++) ctx.fillText(`${m}`,m*sc+2,11)
    for(let m=1;m<room.ancho;m++) ctx.fillText(`${m}`,2,m*sc-2)
    // borde del recinto
    ctx.strokeStyle='rgba(255,255,255,0.3)';ctx.lineWidth=1;ctx.setLineDash([])
    ctx.strokeRect(0,0,CW,CH)

    // plano de fondo
    if(opts.plan&&bgImgEl){
      ctx.save(); ctx.globalAlpha=bgOpacity
      ctx.drawImage(bgImgEl,0,0,CW,CH)
      ctx.restore()
    }

    if(result&&opts.heat){
      const tmp=document.createElement('canvas')
      tmp.width=CW; tmp.height=CH
      const tctx=tmp.getContext('2d')!
      const img=tctx.createImageData(CW,CH)
      for(let py=0;py<CH;py++) for(let px=0;px<CW;px++){
        const lx=bilerp(result.grid,result.GR,result.GC,py/(CH-1),px/(CW-1))
        const [r,g,b]=lux2rgb(lx,result.Emax*1.05)
        const i=(py*CW+px)*4
        img.data[i]=r;img.data[i+1]=g;img.data[i+2]=b;img.data[i+3]=255
      }
      tctx.putImageData(img,0,0)
      ctx.save()
      ctx.globalAlpha=(opts.plan&&bgImgEl)?0.76:1
      ctx.drawImage(tmp,0,0)
      ctx.restore()
    }
  },[result,opts.heat,opts.plan,bgImgEl,bgOpacity,room,CH,wallHex,floorHex])

  // UI overlay
  useEffect(()=>{
    const cv=uRef.current; if(!cv) return
    const ctx=cv.getContext('2d')!
    ctx.clearRect(0,0,CW,CH)

    // grid — puntos sutiles estilo CAD profesional
    if(opts.grid){
      ctx.fillStyle='rgba(255,255,255,0.18)'
      for(let x=sc;x<CW;x+=sc)
        for(let y=sc;y<CH;y+=sc){ctx.beginPath();ctx.arc(x,y,0.8,0,Math.PI*2);ctx.fill()}
      ctx.fillStyle='rgba(255,255,255,0.35)'; ctx.font='7px Inter,sans-serif'
      for(let m=1;m<room.largo;m++) ctx.fillText(`${m}`,m*sc+2,10)
      for(let m=1;m<room.ancho;m++) ctx.fillText(`${m}`,2,m*sc-2)
    }
    ctx.setLineDash([])

    // isolineas
    if(opts.iso&&result){
      ctx.lineWidth=1; ctx.setLineDash([3,3])
      for(const iso of result.isolines){
        const t=iso.value/result.Emax
        const br=Math.round(80-t*60)
        ctx.strokeStyle=`rgba(${br},${br},${br},0.7)`
        for(const [x1,y1,x2,y2] of iso.segs){
          ctx.beginPath();ctx.moveTo(x1*sc,y1*sc);ctx.lineTo(x2*sc,y2*sc);ctx.stroke()
        }
        if(iso.segs.length>0){
          const [x1,y1]=iso.segs[Math.floor(iso.segs.length/2)]
          ctx.setLineDash([])
          ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.font='bold 9px monospace'
          ctx.fillText(`${iso.value}`,x1*sc+2,y1*sc-2)
          ctx.setLineDash([3,3])
        }
      }
      ctx.setLineDash([])
    }

    // valores
    if(opts.vals&&result){
      const cols=10,rows=8
      ctx.font='bold 9px monospace'
      for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
        const lx=bilerp(result.grid,result.GR,result.GC,(r+.5)/rows,(c+.5)/cols)
        ctx.fillStyle=lx<result.Em*.7?P.rd:lx>result.Em*1.3?P.gr:'#e2e8f0'
        ctx.fillText(lx.toFixed(0),(c+.5)/cols*CW-12,(r+.5)/rows*CH+4)
      }
    }

    // paredes dibujadas (polígono de vértices)
    if(vertices.length>0){
      ctx.beginPath()
      ctx.moveTo(vertices[0].x*sc, vertices[0].y*sc)
      for(let i=1;i<vertices.length;i++) ctx.lineTo(vertices[i].x*sc, vertices[i].y*sc)
      ctx.strokeStyle='#ffffff'; ctx.lineWidth=2; ctx.setLineDash([]); ctx.stroke()
      // vértices
      for(const v of vertices){
        ctx.beginPath(); ctx.arc(v.x*sc, v.y*sc, 4, 0, Math.PI*2)
        ctx.fillStyle='#ffffff'; ctx.fill()
      }
    }

    // luminarias — estilo Dialux (teal sobre canvas claro)
    const R=9
    for(const lum of lums){
      const cx=lum.x*sc, cy=lum.y*sc, sel=lum.id===selId
      const pd=polarDist(lum.source)
      const hm=room.alto-room.hPlan
      const maxI=Math.max(...pd)||1
      const beamR=Math.min(120,(pd[0]/maxI)*hm*sc*0.55)
      // halo del haz
      ctx.beginPath();ctx.arc(cx,cy,beamR,0,Math.PI*2)
      ctx.fillStyle=sel?'rgba(37,99,235,0.07)':'rgba(20,184,166,0.08)';ctx.fill()
      // círculo luminaria
      ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2)
      ctx.fillStyle=sel?'#2563eb':'#14b8a6';ctx.fill()
      ctx.strokeStyle=sel?'#60a5fa':'#5eead4';ctx.lineWidth=1.5;ctx.stroke()
      // cruz interior blanca
      ctx.beginPath()
      ctx.moveTo(cx-6,cy);ctx.lineTo(cx+6,cy)
      ctx.moveTo(cx,cy-6);ctx.lineTo(cx,cy+6)
      ctx.strokeStyle='rgba(255,255,255,0.85)';ctx.lineWidth=1.2;ctx.stroke()
      // etiqueta si seleccionada
      if(sel){
        const lb=label(lum.source).slice(0,24)
        ctx.font='bold 8px Inter,sans-serif'
        const tw=ctx.measureText(lb).width+8
        ctx.fillStyle='rgba(37,99,235,0.9)'
        ctx.fillRect(cx-tw/2,cy-R-18,tw,13)
        ctx.fillStyle='#fff';ctx.fillText(lb,cx-tw/2+4,cy-R-7)
      }
    }

    // borde del recinto — oscuro sobre fondo claro
    ctx.strokeStyle='rgba(0,0,0,0.25)';ctx.lineWidth=1;ctx.setLineDash([])
    ctx.strokeRect(0,0,CW,CH)
    cv.style.cursor=tool==='add'?'crosshair':tool==='delete'?'not-allowed':'default'
  },[lums,selId,opts,result,room,sc,tool,wallHex,ceilHex])

  const pos=(e:React.MouseEvent<HTMLCanvasElement>)=>{
    const r=uRef.current!.getBoundingClientRect()
    return{cx:e.clientX-r.left,cy:e.clientY-r.top}
  }
  const hitLum=useCallback((cx:number,cy:number)=>{
    const rad=14/sc
    return lums.find(l=>Math.hypot(l.x-cx/sc,l.y-cy/sc)<rad)||null
  },[lums,sc])

  // ── Preview de herramientas de disposición ────────────────
  const drawPreview=useCallback((ex:number,ey:number)=>{
    const cv=pvRef.current; if(!cv) return
    const ctx=cv.getContext('2d')!
    ctx.clearRect(0,0,CW,CH)
    if(tool==='linea'&&lineStart.current){
      const{x:x1,y:y1}=lineStart.current, x2=ex/sc, y2=ey/sc
      const dx=x2-x1, dy=y2-y1
      ctx.setLineDash([5,4]); ctx.strokeStyle=P.gr; ctx.lineWidth=1.8
      ctx.beginPath(); ctx.moveTo(x1*sc,y1*sc); ctx.lineTo(x2*sc,y2*sc); ctx.stroke()
      ctx.setLineDash([])
      for(let i=0;i<lineN;i++){
        const t=lineN===1?.5:i/(lineN-1)
        ctx.beginPath(); ctx.arc((x1+dx*t)*sc,(y1+dy*t)*sc,7,0,Math.PI*2)
        ctx.fillStyle='rgba(16,185,129,0.35)'; ctx.fill()
        ctx.strokeStyle=P.gr; ctx.lineWidth=1.5; ctx.stroke()
      }
    }
    if(tool==='circulo'){
      const cx2=ex, cy2=ey
      ctx.setLineDash([5,4]); ctx.strokeStyle=P.gr; ctx.lineWidth=1.8
      ctx.beginPath(); ctx.arc(cx2,cy2,circR*sc,0,Math.PI*2); ctx.stroke()
      ctx.setLineDash([])
      for(let i=0;i<circN;i++){
        const ang=(i/circN)*Math.PI*2
        const lx=cx2+circR*sc*Math.cos(ang), ly=cy2+circR*sc*Math.sin(ang)
        ctx.beginPath(); ctx.arc(lx,ly,7,0,Math.PI*2)
        ctx.fillStyle='rgba(16,185,129,0.35)'; ctx.fill()
        ctx.strokeStyle=P.gr; ctx.lineWidth=1.5; ctx.stroke()
      }
    }
    if(tool==='linea'&&!lineStart.current){
      // primer punto: muestra cursor verde
      ctx.beginPath(); ctx.arc(ex,ey,5,0,Math.PI*2)
      ctx.fillStyle=P.gr; ctx.fill()
    }
  },[tool,lineN,circN,circR,sc,CH])

  const clearPreview=useCallback(()=>{
    const cv=pvRef.current; if(!cv) return
    cv.getContext('2d')!.clearRect(0,0,CW,CH)
  },[CH])

  const onMD=useCallback((e:React.MouseEvent<HTMLCanvasElement>)=>{
    const{cx,cy}=pos(e);const hit=hitLum(cx,cy)
    const mx=Math.max(0,Math.min(room.largo,cx/sc))
    const my=Math.max(0,Math.min(room.ancho,cy/sc))

    if(tool==='delete'&&hit){onDel(hit.id);return}
    if(tool==='add'&&!hit){onAdd(mx,my);return}
    if(tool==='draw'){onAddVertex(mx,my);return}

    if(tool==='linea'){
      if(!lineStart.current){
        lineStart.current={x:mx,y:my}
      } else {
        onAutoLinea(lineStart.current.x,lineStart.current.y,mx,my)
        lineStart.current=null
        clearPreview()
      }
      return
    }

    if(tool==='circulo'){
      onAutoCirculo(mx,my)
      clearPreview()
      return
    }

    if(tool==='select'){
      if(hit){
        onSel(hit.id)
        drag.current={id:hit.id,ox:cx/sc-hit.x,oy:cy/sc-hit.y}
      } else {
        if(selId) onMove(selId,mx,my)
        else onSel(null)
      }
    }
  },[tool,hitLum,sc,room,onAdd,onSel,onDel,onMove,onAutoLinea,onAutoCirculo,clearPreview,selId])

  const onMM=useCallback((e:React.MouseEvent<HTMLCanvasElement>)=>{
    const{cx,cy}=pos(e)
    if(drag.current){
      onMove(drag.current.id,
        Math.max(0,Math.min(room.largo,cx/sc-drag.current.ox)),
        Math.max(0,Math.min(room.ancho,cy/sc-drag.current.oy)))
    }
    // preview para herramientas de disposición
    if(tool==='linea'||tool==='circulo') drawPreview(cx,cy)
  },[sc,room,onMove,tool,drawPreview])

  const onML=useCallback(()=>{
    drag.current=null
    clearPreview()
    // si sale del canvas en modo linea, cancela el primer punto
    if(tool!=='linea') return
    // no cancela: permite salir y volver
  },[tool,clearPreview])

  // cursor según herramienta
  const cursor=tool==='add'||tool==='draw'||tool==='linea'||tool==='circulo'?'crosshair':
    tool==='delete'?'not-allowed':'default'

  return(
    <div style={{position:'relative',width:CW,height:CH,flexShrink:0}}>
      <canvas ref={hRef} width={CW} height={CH} style={{position:'absolute',borderRadius:'4px'}}/>
      <canvas ref={uRef} width={CW} height={CH} style={{position:'absolute'}}/>
      <canvas ref={pvRef} width={CW} height={CH} style={{position:'absolute',cursor}}
        onMouseDown={onMD} onMouseMove={onMM}
        onMouseUp={()=>drag.current=null} onMouseLeave={onML}/>
    </div>
  )
}

// ── Paletas de color por superficie ──────────────────────
const SWATCHES_TECHO = [
  {hex:'#f8f8f5',name:'Blanco'},   {hex:'#f0ece0',name:'Marfil'},
  {hex:'#e8e0cc',name:'Crema'},    {hex:'#d4d4d4',name:'Gris perla'},
  {hex:'#c0c0c0',name:'Gris claro'},{hex:'#909090',name:'Gris medio'},
]
const SWATCHES_PAREDES = [
  {hex:'#f0f0ed',name:'Blanco'},   {hex:'#e8d8bc',name:'Beige'},
  {hex:'#d4c8b0',name:'Arena'},    {hex:'#b0b8c4',name:'Azul grisáceo'},
  {hex:'#90a090',name:'Verde salvia'},{hex:'#808080',name:'Gris medio'},
  {hex:'#604840',name:'Terracota'},{hex:'#404040',name:'Gris oscuro'},
]
const SWATCHES_SUELO = [
  {hex:'#c8bdb0',name:'Concreto claro'},{hex:'#b09070',name:'Madera clara'},
  {hex:'#908878',name:'Terrazo'},  {hex:'#706050',name:'Madera media'},
  {hex:'#504840',name:'Concreto oscuro'},{hex:'#181818',name:'Asfalto'},
]

// ── App principal ─────────────────────────────────────────
export default function Simulador(){
  const[s,d]=useReducer(red,init)
  const[result,setResult]=useState<CalcResult|null>(null)
  const[dirty,setDirty]=useState(false)
  const[tool,setTool]=useState<Tool>('select')
  const[vertices,setVertices]=useState<{x:number,y:number}[]>([])
  const[selId,setSelId]=useState<string|null>(null)
  const[presetId,setPresetId]=useState('panel-4000')
  const[gridRows,setGridRows]=useState(2)
  const[gridCols,setGridCols]=useState(3)
  const[lineN,setLineN]=useState(4)
  const[circN,setCircN]=useState(6)
  const[circR,setCircR]=useState(2.0)
  const[ies,setIes]=useState<import('../engine/types').IESData|null>(null)
  const[useIes,setUseIes]=useState(false)
  const[opts,setOpts]=useState({heat:true,iso:true,grid:true,vals:false,plan:false})
  const[tab,setTab]=useState<'recinto'|'luminaria'|'norma'>('luminaria')
  const[section,setSection]=useState<'recinto'|'luminarias'|'calculo'|'informe'>('luminarias')
  const[collapsed,setCollapsed]=useState<string[]>([])
  const toggle=(k:string)=>setCollapsed(p=>p.includes(k)?p.filter(x=>x!==k):[...p,k])
  const open=(k:string)=>!collapsed.includes(k)

  // Colores de superficies
  const[ceilHex,setCeilHex]=useState('#f0ece0')
  const[wallHex,setWallHex]=useState('#d4c8b0')
  const[floorHex,setFloorHex]=useState('#706050')

  // Plano de fondo
  const[bgImage,setBgImage]=useState<string|null>(null)
  const[bgImgEl,setBgImgEl]=useState<HTMLImageElement|null>(null)
  const[bgOpacity,setBgOpacity]=useState(0.45)
  const[bgScale,setBgScale]=useState(100)
  const[bgName,setBgName]=useState('')
  const[bgStatus,setBgStatus]=useState<'idle'|'loading'|'ok'|'error'>('idle')

  // Biblioteca local IES
  const lib=useLibrary()
  const[libSelId,setLibSelId]=useState<string|null>(null)
  const[libSearch,setLibSearch]=useState('')

  useEffect(()=>{
    if(!bgImage){setBgImgEl(null);return}
    const img=new Image()
    img.onload=()=>setBgImgEl(img)
    img.src=bgImage
  },[bgImage])

  // Marcar dirty cuando cambian los inputs
  useEffect(()=>{ setDirty(true) },[s.lums,s.room,s.fm])

  const norma=NORMAS.find(n=>n.id===s.normaId)??NORMAS[0]
  const preset=PRESETS.find(p=>p.id===presetId)??PRESETS[0]
  const src:LightSource=useIes&&ies?{type:'ies',ies}:{type:'preset',preset}
  const selLum=s.lums.find(l=>l.id===selId)??null

  function calcular(){
    if(s.lums.length===0) return
    setResult(calcRoom(s.lums,s.room,s.fm))
    setDirty(false)
  }

  const onAdd=useCallback((x:number,y:number)=>{
    d({t:'ADD',l:{id:`L${Date.now()}`,x,y,source:src,dimming:1}})
  },[src])
  const onMove=useCallback((id:string,x:number,y:number)=>d({t:'MOVE',id,x,y}),[])
  const onDel=useCallback((id:string)=>{d({t:'DEL',id});setSelId(v=>v===id?null:v)},[])

  function autoGrid(rows:number,cols:number){
    d({t:'CLEAR'})
    const{largo:a,ancho:b}=s.room
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++)
      d({t:'ADD',l:{id:`L${Date.now()}_${r}_${c}`,x:a/cols*(c+.5),y:b/rows*(r+.5),source:src,dimming:1}})
  }

  function autoLinea(x1:number,y1:number,x2:number,y2:number){
    const dx=x2-x1, dy=y2-y1
    for(let i=0;i<lineN;i++){
      const t=lineN===1?.5:i/(lineN-1)
      const lx=Math.max(0,Math.min(s.room.largo,x1+dx*t))
      const ly=Math.max(0,Math.min(s.room.ancho,y1+dy*t))
      d({t:'ADD',l:{id:`L${Date.now()}_ln${i}`,x:lx,y:ly,source:src,dimming:1}})
    }
  }

  function autoCirculo(cx:number,cy:number){
    for(let i=0;i<circN;i++){
      const ang=(i/circN)*Math.PI*2
      const lx=Math.max(0,Math.min(s.room.largo,cx+circR*Math.cos(ang)))
      const ly=Math.max(0,Math.min(s.room.ancho,cy+circR*Math.sin(ang)))
      d({t:'ADD',l:{id:`L${Date.now()}_ci${i}`,x:lx,y:ly,source:src,dimming:1}})
    }
  }

  function cambiarTodasFuente(){
    // aplica la fuente activa a TODAS las luminarias
    d({t:'CLEAR'})
    for(const l of s.lums)
      d({t:'ADD',l:{...l,source:src}})
  }

  function handleIES(e:React.ChangeEvent<HTMLInputElement>){
    const f=e.target.files?.[0]; if(!f) return
    const rd=new FileReader()
    rd.onload=ev=>{
      const raw=ev.target?.result as string
      const p=parseIES(raw,f.name)
      if(p){
        setIes(p); setUseIes(true)
        lib.add({
          id:`${f.name}_${Date.now()}`,
          filename:f.name,
          manufacturer:p.manufacturer,
          luminaireName:p.luminaireName,
          totalFlux:Math.round(p.totalFlux),
          inputWatts:p.inputWatts,
          efficacy:+p.efficacy.toFixed(1),
          maxCandela:Math.round(p.maxCandela),
          uploadDate:new Date().toLocaleDateString('es-CL'),
          rawText:raw,
          polarPoints:getCandelaDistributionIES(p),
        })
      }
    }
    rd.readAsText(f)
  }

  function handleDWG(e:React.ChangeEvent<HTMLInputElement>){
    const f=e.target.files?.[0]; if(!f) return
    e.target.value=''
    const ext=f.name.split('.').pop()?.toLowerCase()

    // ── DWG binario ──────────────────────────────────────
    if(ext==='dwg'){
      alert('El formato DWG binario no es accesible en el navegador.\n\nOpciones:\n→ Guarda como DXF desde AutoCAD (Archivo › Guardar como › DXF)\n→ O exporta a PDF/PNG y carga aquí.')
      return
    }

    // ── DXF → parser propio → imagen PNG ─────────────────
    if(ext==='dxf'){
      setBgStatus('loading')
      const rd=new FileReader()
      rd.onload=ev=>{
        try {
          const dataUrl=dxfToDataURL(ev.target?.result as string, 1600, 1200)
          if(!dataUrl){ setBgStatus('error'); return }
          setBgImage(dataUrl); setBgName(f.name)
          setOpts(o=>({...o,plan:true})); setBgStatus('ok')
        } catch{ setBgStatus('error') }
      }
      rd.readAsText(f)
      return
    }

    // ── PDF → pdf.js → imagen PNG ─────────────────────────
    if(ext==='pdf'){
      setBgStatus('loading')
      f.arrayBuffer().then(async buf => {
        try {
          const pdfjsLib = await import('pdfjs-dist')
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`
          const pdf  = await pdfjsLib.getDocument({data: new Uint8Array(buf)}).promise
          const page = await pdf.getPage(1)
          const vp   = page.getViewport({scale: 2.5})
          const cv   = document.createElement('canvas')
          cv.width=vp.width; cv.height=vp.height
          await page.render({canvasContext: cv.getContext('2d')!, canvas: cv, viewport: vp}).promise
          setBgImage(cv.toDataURL('image/png'))
          setBgName(f.name); setOpts(o=>({...o,plan:true})); setBgStatus('ok')
        } catch(err){ console.error(err); setBgStatus('error') }
      })
      return
    }

    // ── Imagen normal (PNG, JPG, SVG…) ───────────────────
    setBgStatus('loading')
    const rd=new FileReader()
    rd.onload=ev=>{
      setBgImage(ev.target?.result as string)
      setBgName(f.name); setOpts(o=>({...o,plan:true})); setBgStatus('ok')
    }
    rd.readAsDataURL(f)
  }

  function printReport(){
    if(!result) return
    const dt = new Date().toLocaleDateString('es-CL',{day:'2-digit',month:'long',year:'numeric'})

    // Capturar el canvas principal como imagen
    const canvases = document.querySelectorAll('canvas')
    let canvasImg = ''
    if(canvases.length >= 2){
      try{
        const tmp = document.createElement('canvas')
        tmp.width = canvases[0].width; tmp.height = canvases[0].height
        const ctx = tmp.getContext('2d')!
        canvases.forEach(cv => ctx.drawImage(cv,0,0))
        canvasImg = tmp.toDataURL('image/png')
      } catch{ canvasImg = '' }
    }

    // Totales de luminarias
    const totalFlux = Math.round(s.lums.reduce((acc,l) => acc + lumens(l.source) * l.dimming, 0))
    const totalW    = s.lums.reduce((acc,l) => acc + watts(l.source) * l.dimming, 0)
    const totalEff  = totalW > 0 ? (totalFlux/totalW).toFixed(1) : '—'
    const area      = s.room.largo * s.room.ancho

    // Agrupar luminarias por modelo
    const grupos = new Map<string, {nombre:string; fab:string; p:number; flux:number; count:number}>()
    s.lums.forEach(l => {
      const n = label(l.source), p = watts(l.source), f = Math.round(lumens(l.source))
      const fab = l.source.type==='ies'&&l.source.ies ? l.source.ies.manufacturer : 'ELUX Preset'
      const key = n
      const prev = grupos.get(key)
      grupos.set(key, prev ? {...prev, count: prev.count+1} : {nombre:n, fab, p, flux:f, count:1})
    })

    const w = window.open('','_blank')!
    w.document.write(`<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"/>
<title>Informe — ${s.nombre}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',Arial,sans-serif;font-weight:300;color:#333;background:#fff;font-size:9pt}
  .page{width:210mm;min-height:297mm;margin:0 auto;padding:18mm 18mm 14mm;page-break-after:always;position:relative}
  .page:last-child{page-break-after:auto}
  .header-bar{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12mm;padding-bottom:4mm;border-bottom:1px solid #e0e0e0}
  .project-ref{font-size:7pt;color:#888;font-weight:400}
  .logo-txt{font-size:28pt;font-weight:700;letter-spacing:-1px;color:#111}
  .logo-txt span{font-weight:300}
  .section-label{font-size:7pt;color:#888;font-weight:400;margin-bottom:2mm}
  .section-title{font-size:14pt;font-weight:600;color:#111;margin-bottom:6mm}
  .cover-image{width:100%;border:1px solid #e0e0e0;display:block;margin:8mm 0}
  table{width:100%;border-collapse:collapse;margin-top:3mm;font-size:8pt}
  th{text-align:left;font-weight:500;padding:2mm 3mm;border-bottom:1.5px solid #111;color:#111;font-size:7.5pt}
  td{padding:2mm 3mm;border-bottom:1px solid #e8e8e8;color:#333}
  tr:last-child td{border-bottom:none}
  .kpi-row{display:flex;gap:8mm;margin-bottom:6mm}
  .kpi{background:#f8f8f8;padding:4mm 5mm;border-left:3px solid #111;flex:1}
  .kpi-label{font-size:7pt;color:#888;margin-bottom:1mm}
  .kpi-value{font-size:13pt;font-weight:600;color:#111}
  .kpi-unit{font-size:8pt;font-weight:300;color:#555}
  .result-ok{color:#1a7a3c;font-weight:600}
  .result-fail{color:#c0392b;font-weight:600}
  .toc-line{display:flex;justify-content:space-between;padding:1.5mm 0;border-bottom:1px dotted #ddd;font-size:8.5pt}
  @media print{
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .page{margin:0;padding:18mm 18mm 14mm}
  }
</style>
</head><body>

<!-- ══ PORTADA ══ -->
<div class="page">
  <div class="header-bar">
    <div>
      <div style="font-size:8pt;color:#888;margin-bottom:1mm">Fecha</div>
      <div style="font-size:9pt">${dt}</div>
    </div>
    <div class="logo-txt">ELUX</div>
  </div>

  ${canvasImg ? `<img src="${canvasImg}" class="cover-image" alt="Vista del proyecto"/>` : `<div style="width:100%;height:80mm;background:#111;margin:8mm 0;display:flex;align-items:center;justify-content:center;color:#555;font-size:10pt">Vista del proyecto</div>`}

  <div style="margin-top:10mm">
    <div style="font-size:16pt;font-weight:600;margin-bottom:2mm">${s.nombre}</div>
    <div style="font-size:9pt;color:#666">${s.room.largo} m × ${s.room.ancho} m × ${s.room.alto} m altura</div>
  </div>

  <div style="position:absolute;bottom:14mm;left:18mm;font-size:7pt;color:#aaa">
    <div>Generado con ELUX</div>
  </div>
</div>

<!-- ══ CONTENIDO ══ -->
<div class="page">
  <div class="header-bar">
    <div class="project-ref">${s.nombre}</div>
    <div class="logo-txt">ELUX</div>
  </div>
  <div class="section-title">Contenido</div>
  <div class="toc-line"><span>Lista de luminarias</span><span>3</span></div>
  <div class="toc-line"><span>Plano de situación</span><span>4</span></div>
  <div class="toc-line"><span>Resultados de cálculo</span><span>5</span></div>
</div>

<!-- ══ LISTA DE LUMINARIAS ══ -->
<div class="page">
  <div class="header-bar">
    <div class="project-ref">${s.nombre}</div>
    <div class="logo-txt">ELUX</div>
  </div>
  <div class="section-title">Lista de luminarias</div>

  <div class="kpi-row">
    <div class="kpi">
      <div class="kpi-label">Φ<sub>total</sub></div>
      <div class="kpi-value">${totalFlux.toLocaleString('es-CL')} <span class="kpi-unit">lm</span></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">P<sub>total</sub></div>
      <div class="kpi-value">${totalW.toFixed(1)} <span class="kpi-unit">W</span></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Rendimiento lumínico</div>
      <div class="kpi-value">${totalEff} <span class="kpi-unit">lm/W</span></div>
    </div>
  </div>

  <table>
    <thead><tr>
      <th>Uni.</th><th>Fabricante</th><th>Nombre del artículo</th>
      <th style="text-align:right">P</th><th style="text-align:right">Φ</th><th style="text-align:right">Eficacia</th>
    </tr></thead>
    <tbody>
      ${[...grupos.values()].map(g=>`<tr>
        <td>${g.count}</td>
        <td>${g.fab}</td>
        <td>${g.nombre}</td>
        <td style="text-align:right">${g.p.toFixed(1)} W</td>
        <td style="text-align:right">${g.flux.toLocaleString('es-CL')} lm</td>
        <td style="text-align:right">${g.p>0?(g.flux/g.p).toFixed(1):'—'} lm/W</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>

<!-- ══ PLANO DE SITUACIÓN ══ -->
<div class="page">
  <div class="header-bar">
    <div class="project-ref">${s.nombre}</div>
    <div class="logo-txt">ELUX</div>
  </div>
  <div class="section-label">Recinto ${s.room.largo} m × ${s.room.ancho} m</div>
  <div class="section-title">Plano de situación de luminarias</div>

  ${canvasImg ? `<img src="${canvasImg}" style="width:100%;border:1px solid #e0e0e0;margin-bottom:6mm" alt="Plano"/>` : ''}

  <table>
    <thead><tr><th>N°</th><th style="text-align:right">X (m)</th><th style="text-align:right">Y (m)</th><th style="text-align:right">Altura (m)</th><th>Modelo</th></tr></thead>
    <tbody>
      ${s.lums.map((l,i)=>`<tr>
        <td>${i+1}</td>
        <td style="text-align:right">${l.x.toFixed(3)}</td>
        <td style="text-align:right">${l.y.toFixed(3)}</td>
        <td style="text-align:right">${s.room.alto.toFixed(3)}</td>
        <td>${label(l.source)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>

<!-- ══ RESULTADOS ══ -->
<div class="page">
  <div class="header-bar">
    <div class="project-ref">${s.nombre}</div>
    <div class="logo-txt">ELUX</div>
  </div>
  <div class="section-label">Recinto ${s.room.largo} m × ${s.room.ancho} m (Área: ${area.toFixed(1)} m²)</div>
  <div class="section-title">Resultados de cálculo</div>

  <div class="kpi-row">
    <div class="kpi">
      <div class="kpi-label">Ē (Iluminancia media)</div>
      <div class="kpi-value ${result.Em>=norma.EmMin?'result-ok':'result-fail'}">${result.Em.toFixed(1)} <span class="kpi-unit">lux</span></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Uniformidad U₀</div>
      <div class="kpi-value ${result.Uo>=norma.Uomin?'result-ok':'result-fail'}">${result.Uo.toFixed(3)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">DPEA</div>
      <div class="kpi-value">${result.DPEA.toFixed(2)} <span class="kpi-unit">W/m²</span></div>
    </div>
  </div>

  <table>
    <thead><tr>
      <th>Propiedades</th>
      <th style="text-align:right">Ē</th>
      <th style="text-align:right">E<sub>mín</sub></th>
      <th style="text-align:right">E<sub>máx</sub></th>
      <th style="text-align:right">U₀</th>
      <th style="text-align:right">DPEA</th>
    </tr></thead>
    <tbody><tr>
      <td>Intensidad lumínica horizontal<br/><span style="font-size:7pt;color:#888">Altura: ${s.room.hPlan.toFixed(3)} m — Norma: ${norma.nombre} (mín. ${norma.EmMin} lux)</span></td>
      <td style="text-align:right;font-weight:500">${result.Em.toFixed(1)} lx</td>
      <td style="text-align:right">${result.Emin.toFixed(1)} lx</td>
      <td style="text-align:right">${result.Emax.toFixed(1)} lx</td>
      <td style="text-align:right">${result.Uo.toFixed(3)}</td>
      <td style="text-align:right">${result.DPEA.toFixed(2)} W/m²</td>
    </tr></tbody>
  </table>


  <div style="position:absolute;bottom:14mm;left:18mm;right:18mm;font-size:7pt;color:#bbb;border-top:1px solid #eee;padding-top:3mm;display:flex;justify-content:space-between">
    <span>Generado con ELUX</span>
    <span>${dt}</span>
  </div>
</div>

<script>window.onload=()=>window.print()</script>
</body></html>`)
    w.document.close()
  }

  const cEm=result?result.Em>=norma.EmMin:false
  const cUo=result?result.Uo>=norma.Uomin:false
  const cats=[...new Set(PRESETS.map(p=>p.categoria))]

  const vizOpts:[keyof typeof opts,string,string][]=[
    ['heat','bi-palette','Falso color'],
    ['iso','bi-bezier','Isolíneas'],
    ['grid','bi-grid','Cuadrícula'],
    ['vals','bi-123','Valores lux'],
    ['plan','bi-map','Plano de fondo'],
  ]

  // handle surface color change + sync reflectance
  function onCeilColor(hex:string,refl:number){ setCeilHex(hex); d({t:'ROOM',p:{rTecho:refl}}) }
  function onWallColor(hex:string,refl:number){ setWallHex(hex); d({t:'ROOM',p:{rParedes:refl}}) }
  function onFloorColor(hex:string,refl:number){ setFloorHex(hex); d({t:'ROOM',p:{rSuelo:refl}}) }

  return(
    <div style={{background:P.bg,height:'100vh',minWidth:'1200px',display:'flex',flexDirection:'column',color:P.tx,overflow:'auto'}}>

      {/* ── Bar principal — logo + tabs + calcular ── */}
      <div style={{height:'38px',background:'#3c3f41',borderBottom:'1px solid #2a2c2e',
        display:'flex',alignItems:'stretch',justifyContent:'space-between',flexShrink:0}}>
        <div style={{display:'flex',alignItems:'stretch'}}>
          {/* Logo */}
          <div style={{display:'flex',alignItems:'center',padding:'0 12px',borderRight:'1px solid #2a2c2e'}}>
            <img src="/images/logelu.png" alt="ELUX" style={{height:'18px',objectFit:'contain'}}/>
          </div>
          {([
            ['recinto',    'bi-building',              'Proyecto'],
            ['luminarias', 'bi-lightbulb-fill',        'Luz'],
            ['calculo',    'bi-calculator',            'Objetos de cálculo'],
            ['informe',    'bi-file-earmark-bar-graph','Informe'],
          ] as [typeof section, string, string][]).map(([sec, icon, lbl])=>(
            <button key={sec} onClick={()=>setSection(sec)}
              style={{
                display:'flex',alignItems:'center',gap:'0.35rem',
                padding:'0 1rem',border:'none',borderRight:'1px solid #2a2c2e',
                cursor:'pointer',fontSize:'0.78rem',fontWeight:400,
                background:section===sec?'#f0f0f0':'transparent',
                color:section===sec?'#1a1a1a':'#aaaaaa',
              }}>
              <i className={`bi ${icon}`} style={{fontSize:'0.82rem',
                color:section===sec?'#333':'#888'}}/>
              {lbl}
            </button>
          ))}
        </div>
        {/* derecha: nombre + calcular + limpiar */}
        <div style={{display:'flex',alignItems:'center',gap:'0.3rem',paddingRight:'0.5rem'}}>
          <input value={s.nombre} onChange={e=>d({t:'NOMBRE',v:e.target.value})}
            style={{background:'transparent',border:'none',borderBottom:'1px solid #555',
              color:'#9ca3af',fontSize:'0.72rem',outline:'none',width:'130px',padding:'0 4px'}}/>
          <button onClick={calcular} disabled={s.lums.length===0}
            style={{padding:'0.18rem 0.7rem',fontSize:'0.7rem',borderRadius:'2px',cursor:'pointer',
              background:dirty&&s.lums.length>0?P.az:'#4a4d50',
              border:'none',color:dirty&&s.lums.length>0?'#fff':'#aaa',
              opacity:s.lums.length===0?0.4:1}}>
            Cálculo
          </button>
          <button onClick={()=>d({t:'CLEAR'})}
            style={{padding:'0.18rem 0.5rem',fontSize:'0.68rem',borderRadius:'2px',
              background:'transparent',border:'1px solid #444',color:'#777',cursor:'pointer'}}>
            Limpiar
          </button>
        </div>
      </div>

      {false&&<div style={{display:'none'}}>


        {section==='luminarias'&&([
          ['select','bi-cursor','Seleccionar / mover'],
          ['add','bi-plus-lg','Colocar luminaria (clic en plano)'],
          ['linea','bi-distribute-horizontal','Disposición lineal'],
          ['circulo','bi-circle','Disposición circular'],
          ['delete','bi-x-lg','Eliminar luminaria'],
        ] as [Tool,string,string][]).map(([t,ic,tt])=>(
          <button key={t} title={tt} onClick={()=>setTool(t)}
            style={{padding:'0.18rem 0.48rem',borderRadius:'2px',fontSize:'0.82rem',cursor:'pointer',
              background:tool===t?'rgba(37,99,235,0.25)':'transparent',
              border:`1px solid ${tool===t?P.az:'transparent'}`,
              color:tool===t?P.azL:'#6b7280'}}>
            <i className={`bi ${ic}`}/>
          </button>
        ))}

        {section==='calculo'&&([
          ['heat','bi-palette-fill','Falso color','Falso color'],
          ['iso','bi-bezier2','Isolíneas','Iso'],
          ['grid','bi-grid-3x3','Cuadrícula','Grid'],
          ['vals','bi-123','Valores lux','Lux'],
          ['plan','bi-map-fill','Plano de fondo','Plano'],
        ] as [keyof typeof opts,string,string,string][]).map(([k,icon,title,lbl])=>(
          <button key={k} title={title} onClick={()=>setOpts(o=>({...o,[k]:!o[k]}))}
            style={{padding:'0.18rem 0.5rem',borderRadius:'2px',fontSize:'0.72rem',cursor:'pointer',
              display:'flex',alignItems:'center',gap:'0.2rem',
              background:opts[k]?'rgba(37,99,235,0.2)':'transparent',
              border:`1px solid ${opts[k]?P.az:'transparent'}`,
              color:opts[k]?P.azL:'#6b7280'}}>
            <i className={`bi ${icon}`}/><span style={{fontSize:'0.62rem'}}>{lbl}</span>
          </button>
        ))}

        {section==='calculo'&&bgImage&&opts.plan&&<>
          <span style={{color:'#333',margin:'0 0.3rem'}}>│</span>
          <span style={{fontSize:'0.6rem',color:'#6b7280'}}>Opacidad</span>
          <input type="range" min={0.1} max={1} step={0.05} value={bgOpacity}
            onChange={e=>setBgOpacity(+e.target.value)} style={{width:'65px',accentColor:P.az}}/>
        </>}

        {section==='informe'&&(
          <button onClick={printReport}
            style={{padding:'0.18rem 0.7rem',fontSize:'0.72rem',borderRadius:'2px',cursor:'pointer',
              display:'flex',alignItems:'center',gap:'0.3rem',
              background:'rgba(37,99,235,0.15)',border:`1px solid ${P.az}`,color:P.azL}}>
            <i className="bi bi-printer"/>Generar informe
          </button>
        )}
      </div>}

      {/* ── Layout: sidebar-iconos + panel + canvas + panel-der ── */}
      <div style={{display:'grid',gridTemplateColumns:'270px 1fr 200px',flex:1,overflow:'hidden'}}>


        {/* ── Panel izquierdo ─────────────────────────────── */}
        <aside style={{width:'270px',minWidth:'270px',maxWidth:'270px',background:'#404346',borderRight:'1px solid #2d2f31',
          display:'flex',flexDirection:'column',flexShrink:0,overflow:'hidden'}}>

          {/* Título del panel — solo para luminarias/calculo/informe */}
          {section!=='recinto'&&<div style={{padding:'6px 10px',background:'#333638',borderBottom:'1px solid #2a2c2e',
            fontSize:'0.75rem',fontWeight:600,color:'#c8c8c8'}}>
            {section==='luminarias'&& 'Luminarias'}
            {section==='calculo'   && 'Objetos de cálculo'}
            {section==='informe'   && 'Documentación'}
          </div>}

          {/* Panel PROYECTO — estilo Dialux */}
          {section==='recinto'&&<div style={{flex:1,overflowY:'auto',fontSize:'0.75rem',color:'#c8c8c8'}}>
            {/* Datos del proyecto */}
            <div onClick={()=>toggle('datos')} style={{background:'#252830',padding:'4px 10px',fontSize:'0.73rem',
              fontWeight:400,color:'#ffffff',cursor:'pointer',display:'flex',justifyContent:'space-between'}}>
              Datos del proyecto
              <span>{open('datos')?'−':'+'}</span>
            </div>
            {open('datos')&&(['Nombre del proyecto','Empresa','Elaborado por','Correo','Teléfono','Lugar','Fecha','Descripción']).map((ph,i)=>(
              <div key={ph} style={{borderBottom:'1px solid #333639'}}>
                {i===0
                  ? <input placeholder={ph} value={s.nombre} onChange={e=>d({t:'NOMBRE',v:e.target.value})}
                      style={{width:'100%',background:'transparent',border:'none',color:'#c8c8c8',
                        padding:'6px 10px',fontSize:'0.75rem',outline:'none'}}/>
                  : <input placeholder={ph}
                      style={{width:'100%',background:'transparent',border:'none',color:'#c8c8c8',
                        padding:'6px 10px',fontSize:'0.75rem',outline:'none'}}/>
                }
              </div>
            ))}

            {/* Plano */}
            <div onClick={()=>toggle('plano')} style={{background:'#252830',padding:'4px 10px',
              fontSize:'0.73rem',fontWeight:400,color:'#ffffff',cursor:'pointer',display:'flex',justifyContent:'space-between'}}>
              Plano<span>{open('plano')?'−':'+'}</span>
            </div>
            {open('plano')&&<>
              <label style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                width:'100%',padding:'6px 10px',borderBottom:'1px solid #333639',cursor:'pointer',background:'transparent'}}>
                <input type="file" accept=".png,.jpg,.jpeg,.gif,.pdf,.dxf" onChange={handleDWG} style={{display:'none'}}/>
                <span style={{fontSize:'0.73rem',color:'#ffffff'}}>Cargar plano</span>
                <span style={{fontSize:'0.65rem',color:P.panelDis}}>DXF · PDF · PNG</span>
              </label>
              <label style={{display:'block',width:'100%',padding:'6px 10px',
                borderBottom:'1px solid #333639',cursor:bgImage?'pointer':'default',background:'transparent'}}>
                <input type="file" accept=".png,.jpg,.jpeg,.gif,.pdf,.dxf" onChange={bgImage?handleDWG:undefined} style={{display:'none'}}/>
                <span style={{fontSize:'0.73rem',color:bgImage?'#ffffff':P.panelDis}}>Cambiar plano</span>
              </label>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 10px',borderBottom:'1px solid #333639'}}>
                <span style={{fontSize:'0.73rem',color:'#ffffff'}}>Unidad de medida</span>
                <select style={{background:'#2a2d32',border:'1px solid #555',
                  color:'#ffffff',padding:'1px 4px',borderRadius:'2px',fontSize:'0.73rem',outline:'none'}}>
                  {['Metros','Centímetros','Milímetros','Kilómetros','Pies','Pulgada'].map(u=>(
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 10px',borderBottom:'1px solid #333639'}}>
                <span style={{fontSize:'0.73rem',color:'#ffffff'}}>Escala</span>
                <div style={{display:'flex',alignItems:'center',gap:'4px'}}>
                  <span style={{fontSize:'0.73rem',color:'#ffffff'}}>1 :</span>
                  <input type="number" value={bgScale} min={1} max={5000} step={1}
                    onChange={e=>setBgScale(+e.target.value)}
                    style={{width:'60px',background:'#2a2d32',border:'1px solid #555',
                      color:'#ffffff',padding:'1px 4px',borderRadius:'2px',
                      fontSize:'0.73rem',outline:'none',textAlign:'right',fontFamily:'inherit'}}/>
                </div>
              </div>
            </>}

            {/* Dibujar sala */}
            <div onClick={()=>toggle('dibujar')} style={{background:'#252830',padding:'4px 10px',
              fontSize:'0.73rem',fontWeight:400,color:'#ffffff',cursor:'pointer',display:'flex',justifyContent:'space-between'}}>
              Dibujar sala<span>{open('dibujar')?'−':'+'}</span>
            </div>
            {open('dibujar')&&<>
              {/* Botones */}
              {[
                {label:'Dibujar sala',    active:true,  action:()=>{setTool('draw');setVertices([])}},
                {label:'Nueva sala vacía',active:true,  action:()=>d({t:'ROOM',p:{largo:10,ancho:8}})},
                {label:'Duplicar sala',   active:true, action:()=>{}},
              ].map((t,i)=>(
                <button key={i} onClick={t.active?t.action:undefined}
                  style={{display:'block',width:'100%',padding:'6px 10px',border:'none',
                    background:'transparent',cursor:t.active?'pointer':'default',
                    borderBottom:'1px solid #333639',textAlign:'left',
                    fontSize:'0.73rem',color:t.active?'#ffffff':'#909090'}}>
                  {t.label}
                </button>
              ))}
              {/* Dimensiones en grilla 2 columnas */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'1px',background:'#333639'}}>
                {[
                  {label:'Largo',       key:'largo', val:s.room.largo, min:1,   max:200, step:0.5},
                  {label:'Ancho',       key:'ancho', val:s.room.ancho, min:1,   max:200, step:0.5},
                  {label:'Altura',      key:'alto',  val:s.room.alto,  min:1.5, max:30,  step:0.1},
                  {label:'H medición',  key:'hPlan', val:s.room.hPlan, min:0,   max:2,   step:0.05},
                ].map(({label,key,val,min,max,step})=>(
                  <div key={key} style={{background:'#404346',padding:'5px 10px'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'3px'}}>
                      <span style={{fontSize:'0.65rem',color:'#ffffff'}}>{label}</span>
                      <span style={{fontSize:'0.65rem',color:'#ffffff'}}>m</span>
                    </div>
                    <input type="number" value={val} min={min} max={max} step={step}
                      onChange={e=>d({t:'ROOM',p:{[key]:+e.target.value}})}
                      style={{width:'100%',background:'#2a2d32',border:'1px solid #555',
                        color:'#ffffff',padding:'2px 4px',borderRadius:'2px',
                        fontSize:'0.8rem',outline:'none',textAlign:'left',fontFamily:'inherit'}}/>
                  </div>
                ))}
              </div>
            </>}



          </div>}

          {/* Tabs internos para secciones luminarias/calculo/informe */}
          {section!=='recinto'&&<>
          <div style={{display:'flex',borderBottom:`1px solid ${P.border}`}}>
            {(['luminaria','recinto','norma'] as const).map(tab2=>(
              <button key={tab2} onClick={()=>setTab(tab2)}
                style={{flex:1,padding:'0.5rem 0',fontSize:'0.6rem',fontWeight:700,
                  textTransform:'uppercase',letterSpacing:'0.05em',
                  background:tab===tab2?P.azF:'transparent',
                  border:'none',borderBottom:`2px solid ${tab===tab2?P.az:'transparent'}`,
                  color:tab===tab2?P.azL:P.mu,cursor:'pointer'}}>
                {tab2==='luminaria'?'Luminaria':tab2==='recinto'?'Local':'Norma'}
              </button>
            ))}
          </div>
          <div style={{flex:1,overflowY:'auto',padding:'0.75rem 0.65rem'}}>

            {/* ── TAB LUMINARIA ── */}
            {tab==='luminaria'&&<>
              <Polar src={src}/>

              {/* Ficha técnica fotométrica */}
              <div style={{background:'#080c18',borderRadius:'8px',padding:'0.6rem',
                marginBottom:'0.8rem',border:`1px solid ${P.border}`}}>
                <p style={{fontSize:'0.6rem',fontWeight:700,color:P.mu,textTransform:'uppercase',
                  letterSpacing:'0.07em',marginBottom:'0.45rem',display:'flex',gap:'0.3rem',alignItems:'center'}}>
                  <i className="bi bi-clipboard-data" style={{color:P.azL}}/>Datos fotométricos
                </p>
                <FichaFotometrica src={src}/>
              </div>

              <Blk title="Fotometría IES" icon="bi-file-earmark-bar-graph">
                <label style={{display:'block',cursor:'pointer',marginBottom:'0.5rem'}}>
                  <input type="file" accept=".ies,.IES" onChange={handleIES} style={{display:'none'}}/>
                  <div style={{background:useIes&&ies?P.grF:P.azF,
                    border:`1px solid ${useIes&&ies?P.grB:`${P.az}40`}`,
                    borderRadius:'6px',padding:'0.4rem',fontSize:'0.72rem',
                    color:useIes&&ies?P.gr:P.azL,textAlign:'center',cursor:'pointer'}}>
                    <i className="bi bi-upload me-1"/>
                    {ies?`✓ ${ies.filename.slice(0,20)}`:'Cargar .IES'}
                  </div>
                </label>
                {ies&&(
                  <div style={{display:'flex',gap:'0.3rem',marginBottom:'0.5rem'}}>
                    {(['ies','preset'] as const).map(t=>(
                      <button key={t} onClick={()=>setUseIes(t==='ies')}
                        style={{flex:1,padding:'0.25rem',fontSize:'0.68rem',borderRadius:'4px',cursor:'pointer',
                          background:(useIes?t==='ies':t==='preset')?P.azF:'transparent',
                          border:`1px solid ${(useIes?t==='ies':t==='preset')?P.az:P.border}`,
                          color:(useIes?t==='ies':t==='preset')?P.azL:P.mu}}>
                        {t==='ies'?'IES':'Preset'}
                      </button>
                    ))}
                  </div>
                )}
              </Blk>

              <Blk title="Biblioteca IES" icon="bi-archive">
                {/* buscador */}
                <input value={libSearch} onChange={e=>setLibSearch(e.target.value)}
                  placeholder="Buscar luminaria…"
                  style={{width:'100%',background:'#050810',border:`1px solid ${P.border}`,
                    color:P.tx,padding:'0.28rem 0.45rem',borderRadius:'5px',
                    fontSize:'0.72rem',outline:'none',marginBottom:'0.4rem'}}
                  onFocus={e=>e.target.style.borderColor=P.az}
                  onBlur={e=>e.target.style.borderColor=P.border}/>

                {lib.items.length===0?(
                  <p style={{fontSize:'0.63rem',color:P.mu,textAlign:'center',
                    lineHeight:1.5,padding:'0.4rem 0.2rem'}}>
                    <i className="bi bi-archive" style={{display:'block',fontSize:'1.4rem',
                      marginBottom:'0.25rem',color:P.border}}/>
                    La biblioteca está vacía.<br/>Carga un .IES y se guardará aquí.
                  </p>
                ):(
                  lib.items
                    .filter(it=>!libSearch||
                      it.luminaireName.toLowerCase().includes(libSearch.toLowerCase())||
                      it.manufacturer.toLowerCase().includes(libSearch.toLowerCase())||
                      it.filename.toLowerCase().includes(libSearch.toLowerCase()))
                    .map(it=>(
                      <div key={it.id} style={{
                        background:libSelId===it.id?P.azF:'#060a14',
                        border:`1px solid ${libSelId===it.id?P.az:P.border}`,
                        borderRadius:'6px',marginBottom:'0.35rem',overflow:'hidden'}}>

                        {/* fila compacta */}
                        <div style={{display:'flex',alignItems:'center',gap:'0.35rem',
                          padding:'0.3rem 0.35rem',cursor:'pointer'}}
                          onClick={()=>setLibSelId(libSelId===it.id?null:it.id)}>
                          <MiniPolar pts={it.polarPoints} size={52}/>
                          <div style={{flex:1,minWidth:0}}>
                            <p style={{fontSize:'0.63rem',color:P.tx,fontWeight:600,
                              whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',
                              margin:0,lineHeight:1.2}}>{it.luminaireName}</p>
                            <p style={{fontSize:'0.56rem',color:P.mu,margin:0,marginBottom:'0.1rem',
                              whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{it.manufacturer}</p>
                            <div style={{display:'flex',gap:'0.2rem',flexWrap:'wrap'}}>
                              <span style={{fontSize:'0.53rem',color:P.azL}}>{it.totalFlux.toLocaleString()} lm</span>
                              <span style={{fontSize:'0.53rem',color:P.mu}}>·</span>
                              <span style={{fontSize:'0.53rem',color:P.azL}}>{it.inputWatts} W</span>
                              <span style={{fontSize:'0.53rem',color:P.mu}}>·</span>
                              <span style={{fontSize:'0.53rem',color:P.gr}}>{it.efficacy} lm/W</span>
                            </div>
                          </div>
                          <div style={{display:'flex',flexDirection:'column',gap:'0.18rem',flexShrink:0}}>
                            <button onClick={e=>{e.stopPropagation()
                              const p=parseIES(it.rawText,it.filename)
                              if(p){setIes(p);setUseIes(true)}}}
                              title="Usar esta luminaria"
                              style={{padding:'0.14rem 0.32rem',fontSize:'0.58rem',borderRadius:'3px',
                                background:P.grF,border:`1px solid ${P.grB}`,color:P.gr,cursor:'pointer',
                                fontWeight:700}}>
                              Usar
                            </button>
                            <button onClick={e=>{e.stopPropagation()
                              lib.remove(it.id);if(libSelId===it.id)setLibSelId(null)}}
                              title="Eliminar de biblioteca"
                              style={{padding:'0.14rem 0.32rem',fontSize:'0.58rem',borderRadius:'3px',
                                background:P.rdF,border:`1px solid ${P.rdB}`,color:P.rd,cursor:'pointer',
                                fontWeight:700}}>
                              ×
                            </button>
                          </div>
                        </div>

                        {/* detalle expandido */}
                        {libSelId===it.id&&(
                          <div style={{borderTop:`1px solid ${P.border}`,padding:'0.4rem 0.4rem 0.45rem'}}>
                            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0.22rem',marginBottom:'0.35rem'}}>
                              {([
                                ['Flujo',`${it.totalFlux.toLocaleString()} lm`],
                                ['Potencia',`${it.inputWatts} W`],
                                ['Eficacia',`${it.efficacy} lm/W`],
                                ['Imax',`${it.maxCandela.toLocaleString()} cd`],
                              ] as [string,string][]).map(([k,v])=>(
                                <div key={k} style={{background:'#070b14',borderRadius:'4px',
                                  padding:'0.22rem 0.3rem',border:`1px solid ${P.border}`}}>
                                  <p style={{fontSize:'0.53rem',color:P.mu,margin:0}}>{k}</p>
                                  <p style={{fontSize:'0.68rem',color:P.azL,fontWeight:700,margin:0}}>{v}</p>
                                </div>
                              ))}
                            </div>
                            <p style={{fontSize:'0.56rem',color:P.mu,marginBottom:'0.3rem',lineHeight:1.4}}>
                              <i className="bi bi-file-earmark-bar-graph me-1"/>
                              {it.filename} — {it.uploadDate}
                            </p>
                            <button onClick={()=>{const p=parseIES(it.rawText,it.filename)
                              if(p){setIes(p);setUseIes(true)}}}
                              style={{width:'100%',padding:'0.3rem',fontSize:'0.7rem',fontWeight:700,
                                borderRadius:'5px',cursor:'pointer',
                                background:`linear-gradient(135deg,${P.gr},#059669)`,
                                border:'none',color:'#fff',display:'flex',alignItems:'center',
                                justifyContent:'center',gap:'0.3rem'}}>
                              <i className="bi bi-check2-circle"/>Usar luminaria
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                )}
              </Blk>

              <Blk title="Preset de luminaria" icon="bi-lightbulb">
                <select value={presetId} onChange={e=>{setPresetId(e.target.value);setUseIes(false)}}
                  style={{width:'100%',background:'#050810',border:`1px solid ${P.border}`,
                    color:P.tx,padding:'0.35rem 0.5rem',borderRadius:'5px',fontSize:'0.8rem',
                    outline:'none',cursor:'pointer'}}>
                  {cats.map(cat=>(
                    <optgroup key={cat} label={cat} style={{color:P.mu}}>
                      {PRESETS.filter(p=>p.categoria===cat).map(p=>(
                        <option key={p.id} value={p.id}>{p.nombre}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Blk>

              <Blk title="Distribución en grilla" icon="bi-grid-3x3">
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 0.4rem',marginBottom:'0.4rem'}}>
                  <Num label="Filas" value={gridRows} min={1} max={30} step={1} onChange={v=>setGridRows(Math.max(1,Math.round(v)))}/>
                  <Num label="Columnas" value={gridCols} min={1} max={30} step={1} onChange={v=>setGridCols(Math.max(1,Math.round(v)))}/>
                </div>
                <button onClick={()=>autoGrid(gridRows,gridCols)}
                  style={{width:'100%',padding:'0.38rem',fontSize:'0.73rem',fontWeight:700,
                    borderRadius:'5px',cursor:'pointer',marginBottom:'0.4rem',
                    background:`linear-gradient(135deg,${P.az},#1d4ed8)`,
                    border:'none',color:'#fff',display:'flex',alignItems:'center',
                    justifyContent:'center',gap:'0.35rem'}}>
                  <i className="bi bi-grid-3x3-gap"/>
                  Distribuir {gridRows}×{gridCols} ({gridRows*gridCols} ud)
                </button>
                <div style={{display:'flex',flexWrap:'wrap',gap:'0.2rem'}}>
                  {[[1,1],[1,2],[2,2],[2,3],[3,3],[3,4],[4,4],[4,5],[5,5]].map(([r,c])=>(
                    <button key={`${r}x${c}`}
                      onClick={()=>{setGridRows(r);setGridCols(c);autoGrid(r,c)}}
                      style={{padding:'0.18rem 0.38rem',fontSize:'0.62rem',borderRadius:'4px',
                        background: gridRows===r&&gridCols===c?P.azF:'transparent',
                        border:`1px solid ${gridRows===r&&gridCols===c?`${P.az}60`:P.border}`,
                        color:gridRows===r&&gridCols===c?P.azL:P.mu2,cursor:'pointer'}}>
                      {r}×{c}
                    </button>
                  ))}
              </div>
              <div style={{marginTop:'0.8rem', paddingTop:'0.8rem', borderTop:`1px solid ${P.border}`}}>
                <p style={{fontSize:'0.58rem', color:P.mu2, textTransform:'uppercase', letterSpacing:'0.04em', marginBottom:'0.4rem'}}>Disposición Lineal / Circular</p>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 0.4rem'}}>
                  <Num label="Cant. Lineal" value={lineN} min={2} max={100} step={1} onChange={v => setLineN(Math.round(v))}/>
                  <Num label="Cant. Circular" value={circN} min={3} max={100} step={1} onChange={v => setCircN(Math.round(v))}/>
                </div>
                <Num label="Radio Círculo" unit="m" value={circR} min={0.1} max={50} step={0.1} onChange={setCircR}/>
                </div>
              </Blk>

              {selLum&&(
                <Blk title="Luminaria seleccionada" icon="bi-cursor">
                  <p style={{fontSize:'0.67rem',color:P.azL,marginBottom:'0.4rem',lineHeight:1.4,
                    background:P.azF,border:`1px solid ${P.az}30`,borderRadius:'5px',padding:'0.3rem 0.4rem'}}>
                    {label(selLum.source)}
                  </p>
                  {/* Posición exacta con inputs */}
                  <div style={{marginBottom:'0.5rem'}}>
                    <p style={{fontSize:'0.6rem',color:P.mu,textTransform:'uppercase',letterSpacing:'0.06em',
                      fontWeight:700,marginBottom:'0.3rem',display:'flex',alignItems:'center',gap:'0.25rem'}}>
                      <i className="bi bi-geo-alt" style={{color:P.azL}}/>Posición (metros)
                    </p>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 0.4rem'}}>
                      <Num label="X" unit="m"
                        value={+selLum.x.toFixed(2)} min={0} max={s.room.largo} step={0.05}
                        onChange={v=>onMove(selLum.id, Math.max(0,Math.min(s.room.largo,v)), selLum.y)}/>
                      <Num label="Y" unit="m"
                        value={+selLum.y.toFixed(2)} min={0} max={s.room.ancho} step={0.05}
                        onChange={v=>onMove(selLum.id, selLum.x, Math.max(0,Math.min(s.room.ancho,v)))}/>
                    </div>
                    <p style={{fontSize:'0.58rem',color:P.mu,marginTop:'0.15rem'}}>
                      <i className="bi bi-arrows-move me-1" style={{color:P.mu2}}/>
                      También puedes arrastrar la luminaria en el plano
                    </p>
                  </div>
                  {/* Atenuación */}
                  <div style={{marginBottom:'0.4rem'}}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:'0.1rem'}}>
                      <span style={{fontSize:'0.65rem',color:P.mu2}}>Atenuación</span>
                      <span style={{fontSize:'0.65rem',color:P.azL,fontWeight:700}}>{Math.round(selLum.dimming*100)}%</span>
                    </div>
                    <input type="range" min={0.1} max={1} step={0.05} value={selLum.dimming}
                      onChange={e=>d({t:'DIM',id:selLum.id,v:+e.target.value})}
                      style={{width:'100%',accentColor:P.az}}/>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.55rem',color:P.mu,marginTop:'0.1rem'}}>
                      <span>10%</span><span>50%</span><span>100%</span>
                    </div>
                    <div style={{marginTop:'0.8rem'}}>
                      <button onClick={cambiarTodasFuente}
                        style={{width:'100%', padding:'0.3rem', fontSize:'0.65rem', borderRadius:'5px', background:'transparent', border:`1px solid ${P.border}`, color:P.mu2, cursor:'pointer'}}>
                        Aplicar fotometría a todas
                      </button>
                    </div>
                  </div>
                  <button onClick={()=>onDel(selLum.id)}
                    style={{width:'100%',padding:'0.28rem',fontSize:'0.7rem',borderRadius:'5px',
                      background:P.rdF,border:`1px solid ${P.rdB}`,color:P.rd,cursor:'pointer'}}>
                    <i className="bi bi-trash me-1"/>Eliminar luminaria
                  </button>
                </Blk>
              )}
            </>}

            {/* ── TAB RECINTO ── */}
            {tab==='recinto'&&<>
              {/* ── Estilo Dialux: label izq / valor der ── */}
              {(() => {
                const Row = ({label, children}: {label:string, children:React.ReactNode}) => (
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                    padding:'3px 8px',borderBottom:'1px solid #333639'}}>
                    <span style={{fontSize:'0.72rem',color:'#9ca3af'}}>{label}</span>
                    <span style={{fontSize:'0.72rem',color:'#d1d5db'}}>{children}</span>
                  </div>
                )
                const NumRow = ({label, unit, value, min, max, step, onChange}: {label:string;unit?:string;value:number;min?:number;max?:number;step?:number;onChange:(v:number)=>void}) => (
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                    padding:'3px 8px',borderBottom:'1px solid #333639'}}>
                    <span style={{fontSize:'0.72rem',color:'#9ca3af'}}>{label}</span>
                    <div style={{display:'flex',alignItems:'center',gap:'3px'}}>
                      <input type="number" value={value} min={min} max={max} step={step??'any'}
                        onChange={e=>onChange(+e.target.value)}
                        style={{width:'52px',background:'#2a2d32',border:'1px solid #3a3d42',
                          color:'#d1d5db',padding:'1px 4px',borderRadius:'2px',fontSize:'0.72rem',
                          outline:'none',textAlign:'right'}}/>
                      {unit&&<span style={{fontSize:'0.65rem',color:'#6b7280'}}>{unit}</span>}
                    </div>
                  </div>
                )
                const Section = ({title, children}: {title:string, children:React.ReactNode}) => (
                  <div style={{marginBottom:'1px'}}>
                    <div style={{background:'#2e3135',padding:'3px 8px',fontSize:'0.65rem',
                      fontWeight:600,color:'#9ca3af',textTransform:'uppercase',letterSpacing:'0.06em'}}>
                      {title}
                    </div>
                    {children}
                  </div>
                )
                return <>
                  <Section title="Recinto activo">
                    <Row label="Nombre"><input value={s.nombre} onChange={e=>d({t:'NOMBRE',v:e.target.value})}
                      style={{background:'#2a2d32',border:'1px solid #3a3d42',color:'#d1d5db',
                        padding:'1px 4px',borderRadius:'2px',fontSize:'0.72rem',outline:'none',width:'110px'}}/></Row>
                    <Row label="Descripción"><span style={{color:'#555',fontSize:'0.65rem'}}>—</span></Row>
                  </Section>

                  <Section title="Dimensiones">
                    <NumRow label="Largo" unit="m" value={s.room.largo} min={1} max={200} step={0.5} onChange={v=>d({t:'ROOM',p:{largo:v}})}/>
                    <NumRow label="Ancho" unit="m" value={s.room.ancho} min={1} max={200} step={0.5} onChange={v=>d({t:'ROOM',p:{ancho:v}})}/>
                    <NumRow label="Altura" unit="m" value={s.room.alto} min={1.5} max={30} step={0.1} onChange={v=>d({t:'ROOM',p:{alto:v}})}/>
                    <NumRow label="Plano de trabajo" unit="m" value={s.room.hPlan} min={0} max={2} step={0.05} onChange={v=>d({t:'ROOM',p:{hPlan:v}})}/>
                  </Section>

                  <Section title="Mantenimiento">
                    <div style={{padding:'4px 8px',display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #333639'}}>
                      <span style={{fontSize:'0.72rem',color:'#9ca3af'}}>Factor de degradación MF</span>
                      <input type="number" value={s.fm} min={0.5} max={1} step={0.01}
                        onChange={e=>d({t:'FM',v:+e.target.value})}
                        style={{width:'48px',background:'#2a2d32',border:'1px solid #3a3d42',
                          color:'#d1d5db',padding:'1px 4px',borderRadius:'2px',fontSize:'0.72rem',
                          outline:'none',textAlign:'right'}}/>
                    </div>
                  </Section>

                  <Section title="Superficies">
                    {[
                      {label:'Techo', hex:ceilHex, refl:s.room.rTecho, sw:SWATCHES_TECHO, fn:onCeilColor},
                      {label:'Paredes', hex:wallHex, refl:s.room.rParedes, sw:SWATCHES_PAREDES, fn:onWallColor},
                      {label:'Suelo', hex:floorHex, refl:s.room.rSuelo, sw:SWATCHES_SUELO, fn:onFloorColor},
                    ].map(({label,hex,refl,sw,fn})=>(
                      <div key={label} style={{padding:'4px 8px',borderBottom:'1px solid #333639'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'3px'}}>
                          <span style={{fontSize:'0.72rem',color:'#9ca3af'}}>{label}</span>
                          <div style={{display:'flex',alignItems:'center',gap:'5px'}}>
                            <span style={{fontSize:'0.65rem',color:'#6b7280'}}>{Math.round(refl*100)}%</span>
                            <label style={{cursor:'pointer',position:'relative'}}>
                              <input type="color" value={hex} onChange={e=>fn(e.target.value,hexToRefl(e.target.value))}
                                style={{opacity:0,position:'absolute',width:'100%',height:'100%',cursor:'pointer'}}/>
                              <div style={{width:'18px',height:'18px',borderRadius:'2px',background:hex,border:'1px solid #555'}}/>
                            </label>
                          </div>
                        </div>
                        <div style={{display:'flex',gap:'2px',flexWrap:'wrap'}}>
                          {sw.map(s2=>(
                            <button key={s2.hex} title={s2.name} onClick={()=>fn(s2.hex,hexToRefl(s2.hex))}
                              style={{width:'16px',height:'16px',borderRadius:'2px',background:s2.hex,cursor:'pointer',padding:0,
                                border:`1px solid ${hex===s2.hex?'#60a5fa':'transparent'}`}}/>
                          ))}
                        </div>
                      </div>
                    ))}
                  </Section>

                  <Section title="Plano de fondo">
                    <div style={{padding:'5px 8px'}}>
                      <label style={{display:'block',cursor:'pointer'}}>
                        <input type="file" accept=".png,.jpg,.jpeg,.pdf,.dxf" onChange={handleDWG} style={{display:'none'}}/>
                        <div style={{background:'#2a2d32',border:'1px solid #3a3d42',borderRadius:'2px',
                          padding:'4px 8px',fontSize:'0.7rem',color:bgImage?'#60a5fa':'#6b7280',cursor:'pointer',textAlign:'center'}}>
                          {bgImage ? `✓ ${bgName.slice(0,20)}` : 'Cargar plano (DXF · PDF · PNG)'}
                        </div>
                      </label>
                      {bgImage&&<div style={{marginTop:'4px',display:'flex',gap:'4px'}}>
                        <button onClick={()=>{setBgImage(null);setBgName('');setBgStatus('idle');setOpts(o=>({...o,plan:false}))}}
                          style={{flex:1,padding:'2px',fontSize:'0.65rem',borderRadius:'2px',cursor:'pointer',
                            background:'transparent',border:'1px solid #555',color:'#888'}}>Quitar</button>
                        <button onClick={()=>setOpts(o=>({...o,plan:!o.plan}))}
                          style={{flex:1,padding:'2px',fontSize:'0.65rem',borderRadius:'2px',cursor:'pointer',
                            background:opts.plan?'rgba(37,99,235,0.2)':'transparent',border:`1px solid ${opts.plan?P.az:'#555'}`,color:opts.plan?P.azL:'#888'}}>
                          {opts.plan?'Visible':'Oculto'}</button>
                      </div>}
                    </div>
                  </Section>
                </>
              })()}

              {/* Colores de superficies — ya integrado arriba */}
              {false && <Blk title="Color de superficies" icon="bi-palette2">
                <div style={{background:'#070b14',border:`1px solid ${P.border}`,
                  borderRadius:'6px',padding:'0.5rem',marginBottom:'0.5rem'}}>
                  {/* mini preview recinto */}
                  <div style={{position:'relative',height:'52px',marginBottom:'0.5rem',
                    borderRadius:'4px',overflow:'hidden',border:`1px solid ${P.border}`}}>
                    <div style={{position:'absolute',inset:0,background:floorHex+'90'}}/>
                    {/* paredes */}
                    <div style={{position:'absolute',top:0,left:0,right:0,height:'10px',background:ceilHex+'b0'}}/>
                    <div style={{position:'absolute',bottom:0,left:0,right:0,height:'10px',background:ceilHex+'b0'}}/>
                    <div style={{position:'absolute',top:0,bottom:0,left:0,width:'10px',background:wallHex+'b0'}}/>
                    <div style={{position:'absolute',top:0,bottom:0,right:0,width:'10px',background:wallHex+'b0'}}/>
                    <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',
                      justifyContent:'center',fontSize:'0.58rem',color:'rgba(255,255,255,0.5)'}}>
                      Vista en planta
                    </div>
                  </div>
                  <SurfaceColor label="Techo" hex={ceilHex} refl={s.room.rTecho}
                    swatches={SWATCHES_TECHO} onChange={onCeilColor}/>
                  <SurfaceColor label="Paredes" hex={wallHex} refl={s.room.rParedes}
                    swatches={SWATCHES_PAREDES} onChange={onWallColor}/>
                  <SurfaceColor label="Suelo" hex={floorHex} refl={s.room.rSuelo}
                    swatches={SWATCHES_SUELO} onChange={onFloorColor}/>
                </div>
                <p style={{fontSize:'0.58rem',color:P.mu,lineHeight:1.5}}>
                  <i className="bi bi-info-circle me-1" style={{color:P.azL}}/>
                  El color actualiza la reflectancia automáticamente.
                </p>
              </Blk>}

              {/* Plano DWG */}
              <Blk title="Plano de fondo" icon="bi-map">
                <label style={{display:'block',cursor:'pointer',marginBottom:'0.35rem'}}>
                  <input type="file" accept=".png,.jpg,.jpeg,.gif,.svg,.bmp,.pdf,.dxf,.dwg"
                    onChange={handleDWG} style={{display:'none'}}/>
                  <div style={{
                    background: bgStatus==='loading'?'rgba(245,158,11,0.1)':bgImage?P.grF:P.azF,
                    border:`1px solid ${bgStatus==='loading'?P.am:bgImage?P.grB:`${P.az}40`}`,
                    borderRadius:'6px',padding:'0.45rem 0.5rem',fontSize:'0.72rem',
                    color: bgStatus==='loading'?P.am:bgImage?P.gr:P.azL,
                    textAlign:'center',cursor:'pointer',transition:'all .2s'}}>
                    {bgStatus==='loading'
                      ? <><i className="bi bi-hourglass-split me-1"/>Procesando…</>
                      : bgStatus==='error'
                        ? <><i className="bi bi-exclamation-triangle me-1"/>Error — intenta otro archivo</>
                        : bgImage
                          ? <><i className="bi bi-check2 me-1"/>{bgName.slice(0,24)}</>
                          : <><i className="bi bi-cloud-upload me-1"/>Cargar plano (PDF · DXF · PNG · JPG)</>
                    }
                  </div>
                </label>
                {/* formatos soportados */}
                <div style={{display:'flex',gap:'0.25rem',flexWrap:'wrap',marginBottom:'0.4rem'}}>
                  {[['PDF','bi-file-earmark-pdf',P.rd],['DXF','bi-file-earmark-code',P.az],['PNG/JPG','bi-file-image',P.gr]].map(([f,ic,col])=>(
                    <span key={f} style={{fontSize:'0.55rem',padding:'0.1rem 0.35rem',borderRadius:'10px',
                      background:'rgba(255,255,255,0.04)',border:`1px solid ${P.border}`,
                      color: col as string,display:'flex',alignItems:'center',gap:'0.2rem'}}>
                      <i className={`bi ${ic}`}/>{f}
                    </span>
                  ))}
                  <span style={{fontSize:'0.55rem',padding:'0.1rem 0.35rem',borderRadius:'10px',
                    background:'rgba(255,255,255,0.04)',border:`1px solid ${P.border}`,
                    color:P.mu,display:'flex',alignItems:'center',gap:'0.2rem'}}>
                    <i className="bi bi-x-circle"/>DWG ×
                  </span>
                </div>

                {bgImage&&(
                  <>
                    <div style={{display:'flex',gap:'0.3rem',marginBottom:'0.4rem'}}>
                      <button onClick={()=>{setBgImage(null);setBgName('');setBgStatus('idle');setOpts(o=>({...o,plan:false}))}}
                        style={{flex:1,padding:'0.22rem',fontSize:'0.65rem',borderRadius:'4px',cursor:'pointer',
                          background:P.rdF,border:`1px solid ${P.rdB}`,color:P.rd}}>
                        <i className="bi bi-x-circle me-1"/>Quitar
                      </button>
                      <button onClick={()=>setOpts(o=>({...o,plan:!o.plan}))}
                        style={{flex:1,padding:'0.22rem',fontSize:'0.65rem',borderRadius:'4px',cursor:'pointer',
                          background:opts.plan?P.grF:P.azF,
                          border:`1px solid ${opts.plan?P.grB:`${P.az}40`}`,
                          color:opts.plan?P.gr:P.azL}}>
                        {opts.plan?'✓ Visible':'Oculto'}
                      </button>
                    </div>
                    <div>
                      <div style={{display:'flex',justifyContent:'space-between',marginBottom:'0.15rem'}}>
                        <span style={{fontSize:'0.65rem',color:P.mu2}}>Opacidad</span>
                        <span style={{fontSize:'0.65rem',color:P.azL,fontWeight:700}}>{Math.round(bgOpacity*100)}%</span>
                      </div>
                      <input type="range" min={0.1} max={1} step={0.05} value={bgOpacity}
                        onChange={e=>setBgOpacity(+e.target.value)}
                        style={{width:'100%',accentColor:P.az}}/>
                    </div>
                  </>
                )}
              </Blk>


              <Blk title="Reflectancias (manual)" icon="bi-brightness-high">
                <Num label="Techo" unit="%" value={Math.round(s.room.rTecho*100)} min={0} max={95} step={5}
                  onChange={v=>d({t:'ROOM',p:{rTecho:v/100}})}/>
                <Num label="Paredes" unit="%" value={Math.round(s.room.rParedes*100)} min={0} max={85} step={5}
                  onChange={v=>d({t:'ROOM',p:{rParedes:v/100}})}/>
                <Num label="Suelo" unit="%" value={Math.round(s.room.rSuelo*100)} min={0} max={60} step={5}
                  onChange={v=>d({t:'ROOM',p:{rSuelo:v/100}})}/>
              </Blk>

              <Blk title="Factor de mantenimiento" icon="bi-wrench-adjustable">
                {[['0.50','Muy sucio'],['0.65','Sucio'],['0.75','Polvoriento'],['0.80','LED normal'],['0.85','Limpio']].map(([v,lb])=>(
                  <button key={v} onClick={()=>d({t:'FM',v:+v})}
                    style={{display:'block',width:'100%',textAlign:'left',
                      background:Math.abs(s.fm-+v)<.005?P.azF:'transparent',
                      border:`1px solid ${Math.abs(s.fm-+v)<.005?P.az:P.border}`,
                      color:Math.abs(s.fm-+v)<.005?P.azL:P.mu2,
                      borderRadius:'5px',padding:'0.22rem 0.5rem',fontSize:'0.68rem',cursor:'pointer',marginBottom:'0.2rem'}}>
                    <strong>{v}</strong> — {lb}
                  </button>
                ))}
              </Blk>
            </>}

            {/* ── TAB NORMA ── */}
            {tab==='norma'&&<>
              <Blk title="Tipo de espacio — RIC N°10" icon="bi-shield-check">
                {[...new Set(NORMAS.map(n=>n.categoria))].map(cat=>(
                  <div key={cat} style={{marginBottom:'0.5rem'}}>
                    <p style={{fontSize:'0.58rem',color:'#2d3748',textTransform:'uppercase',letterSpacing:'0.04em',marginBottom:'0.2rem'}}>{cat}</p>
                    {NORMAS.filter(n=>n.categoria===cat).map(n=>(
                      <button key={n.id} onClick={()=>d({t:'NORMA',id:n.id})}
                        style={{display:'block',width:'100%',textAlign:'left',
                          background:n.id===s.normaId?P.azF:'transparent',
                          border:`1px solid ${n.id===s.normaId?`${P.az}50`:'transparent'}`,
                          color:n.id===s.normaId?P.azL:P.mu2,
                          borderRadius:'4px',padding:'0.2rem 0.4rem',fontSize:'0.68rem',cursor:'pointer',marginBottom:'0.1rem'}}>
                          {n.nombre} <span style={{color:P.am,fontSize:'0.62rem'}}>— {n.EmMin} lx</span>
                      </button>
                    ))}
                  </div>
                ))}
              </Blk>
              <Blk title="Requisitos" icon="bi-info-circle">
                {[['Em mínima',`≥ ${norma.EmMin} lux`],['Uniformidad Uo',`≥ ${norma.Uomin}`],['UGR max',`≤ ${norma.UGRmax}`],['Ra mínimo',`≥ ${norma.Ramin}`]].map(([k,v])=>(
                  <div key={k} style={{display:'flex',justifyContent:'space-between',fontSize:'0.7rem',marginBottom:'0.28rem'}}>
                    <span style={{color:P.mu2}}>{k}</span><strong style={{color:P.tx}}>{v}</strong>
                  </div>
                ))}
              </Blk>
            </>}
          </div>
          </>}
        </aside>

        {/* ── Centro ──────────────────────────────────────── */}
        <main style={{flex:1,overflow:'auto',padding:'0',
          display:'flex',flexDirection:'column',background:'#3f4349'}}>


          {/* Canvas — ocupa todo el espacio disponible */}
          <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
            {/* Barra de info sobre el canvas */}
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',
              padding:'0.3rem 0.6rem',borderBottom:`1px solid ${P.border}`,background:'#080c16',flexShrink:0}}>
              <span style={{fontSize:'0.62rem',color:P.mu}}>
                {s.room.largo}×{s.room.ancho} m · H {s.room.alto} m · PT {s.room.hPlan} m
              </span>
              <div style={{display:'flex',alignItems:'center',gap:'0.35rem'}}>
                {[
                  {hex:ceilHex,  label:`Techo ${Math.round(s.room.rTecho*100)}%`},
                  {hex:wallHex,  label:`Paredes ${Math.round(s.room.rParedes*100)}%`},
                  {hex:floorHex, label:`Suelo ${Math.round(s.room.rSuelo*100)}%`},
                ].map(({hex,label:lb})=>(
                  <div key={lb} title={lb} style={{width:'11px',height:'11px',borderRadius:'2px',
                    background:hex,border:`1px solid ${P.border}`}}/>
                ))}
                <span style={{color:P.border,margin:'0 0.2rem'}}>|</span>
                {tool==='add'    &&<span style={{fontSize:'0.6rem',color:P.azL}}>+ colocar luminaria</span>}
                {tool==='delete' &&<span style={{fontSize:'0.6rem',color:P.rd}}>× eliminar</span>}
                {tool==='select' &&<span style={{fontSize:'0.6rem',color:P.mu}}>seleccionar / mover</span>}
                {tool==='linea'  &&<span style={{fontSize:'0.6rem',color:P.azL}}>lineal ({lineN} ud)</span>}
                {tool==='circulo'&&<span style={{fontSize:'0.6rem',color:P.azL}}>circular ({circN} ud · R={circR}m)</span>}
              </div>
            </div>

            {/* Workspace */}
            <div style={{flex:1,overflow:'auto',display:'flex',alignItems:'flex-start',
              justifyContent:'flex-start',padding:'0.5rem',background:'#0a0c10'}}>
              <div style={{display:'flex',flexDirection:'column',gap:'0.4rem'}}>
                <Canvas room={s.room} lums={s.lums} result={result} tool={tool} selId={selId}
                  opts={opts} bgImgEl={bgImgEl} bgOpacity={bgOpacity}
                  wallHex={wallHex} ceilHex={ceilHex} floorHex={floorHex}
                  lineN={lineN} circN={circN} circR={circR}
                  onAdd={onAdd} onMove={onMove} onSel={setSelId} onDel={onDel}
                  onAutoLinea={autoLinea} onAutoCirculo={autoCirculo}
                  vertices={vertices}
                  onAddVertex={(x,y)=>setVertices(v=>[...v,{x,y}])}/>
                {opts.heat&&result&&(
                  <ColorLegend emax={Math.round(result.Emax)} width={CW}/>
                )}
              </div>
            </div>
          </div>

        </main>

        {/* ── Panel derecho ───────────────────────────────── */}
        <aside style={{width:'200px',minWidth:'200px',background:P.panel,borderLeft:`1px solid ${P.border}`,
          overflowY:'auto',padding:'0.75rem 0.65rem',flexShrink:0}}>
          <p style={{fontSize:'0.62rem',fontWeight:700,color:P.mu,textTransform:'uppercase',
            letterSpacing:'0.08em',marginBottom:'0.7rem',display:'flex',gap:'0.3rem',alignItems:'center'}}>
            <i className="bi bi-bar-chart" style={{color:P.azL}}/>RESULTADOS
          </p>

          {result&&s.lums.length>0 ? (
            <>
              {[
                {lb:'Em media',   v:result.Em.toFixed(0),      u:'lux',  ok:cEm, req:`≥${norma.EmMin}`},
                {lb:'Emin',       v:result.Emin.toFixed(0),    u:'lux',  ok:null,req:''},
                {lb:'Emax',       v:result.Emax.toFixed(0),    u:'lux',  ok:null,req:''},
                {lb:'Uo',         v:result.Uo.toFixed(2),      u:'',     ok:cUo, req:`≥${norma.Uomin}`},
                {lb:'Potencia',   v:String(result.totalW),     u:'W',    ok:null,req:''},
                {lb:'Flujo tot.', v:result.totalLm.toFixed(0), u:'lm',   ok:null,req:''},
                {lb:'DPEA',       v:result.DPEA.toFixed(1),    u:'W/m²', ok:result.DPEA<=15,req:'≤15'},
              ].map(k=>(
                <div key={k.lb} style={{background:'#070b14',border:`1px solid ${P.border}`,
                  borderRadius:'6px',padding:'0.5rem 0.6rem',marginBottom:'0.35rem'}}>
                  <p style={{fontSize:'0.62rem',color:P.mu,marginBottom:'0.1rem'}}>{k.lb}</p>
                  <p style={{fontSize:'1.2rem',fontWeight:800,margin:0,
                    color:k.ok===true?P.gr:k.ok===false?P.rd:P.azL}}>
                    {k.v}<span style={{fontSize:'0.62rem',color:P.mu,marginLeft:'0.15rem'}}>{k.u}</span>
                  </p>
                  {k.req&&<p style={{fontSize:'0.58rem',color:P.mu,marginTop:'0.05rem'}}>{k.req}</p>}
                </div>
              ))}

              <div style={{marginTop:'0.5rem',paddingTop:'0.5rem',borderTop:`1px solid ${P.border}`}}>
                <p style={{fontSize:'0.62rem',color:P.mu,marginBottom:'0.3rem'}}>Luminarias: <strong style={{color:P.tx}}>{s.lums.length} ud</strong></p>
                <p style={{fontSize:'0.62rem',color:P.mu,marginBottom:'0.3rem'}}>Eficacia: <strong style={{color:P.tx}}>{result.totalW>0?(result.totalLm/result.totalW).toFixed(1):0} lm/W</strong></p>
                <p style={{fontSize:'0.62rem',color:P.mu}}>Área: <strong style={{color:P.tx}}>{(s.room.largo*s.room.ancho).toFixed(1)} m²</strong></p>
              </div>

              <div style={{marginTop:'0.6rem',paddingTop:'0.6rem',borderTop:`1px solid ${P.border}`}}>
                <p style={{fontSize:'0.62rem',fontWeight:700,color:P.mu,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:'0.4rem'}}>Verificación</p>
                {[
                  {lb:`Em ≥ ${norma.EmMin}`,ok:cEm},
                  {lb:`Uo ≥ ${norma.Uomin}`,ok:cUo},
                  {lb:'DPEA ≤ 15',ok:result.DPEA<=15},
                ].map(row=>(
                  <div key={row.lb} style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                    padding:'0.28rem 0.4rem',marginBottom:'0.2rem',borderRadius:'5px',
                    background:row.ok?P.grF:P.rdF,border:`1px solid ${row.ok?P.grB:P.rdB}`}}>
                    <span style={{fontSize:'0.6rem',color:P.mu2}}>{row.lb}</span>
                    <i className={`bi ${row.ok?'bi-check-lg':'bi-x-lg'}`}
                      style={{color:row.ok?P.gr:P.rd,fontSize:'0.7rem'}}/>
                  </div>
                ))}
              </div>

              {/* Escala de colores con lux */}
              <div style={{marginTop:'0.6rem',paddingTop:'0.6rem',borderTop:`1px solid ${P.border}`}}>
                <p style={{fontSize:'0.6rem',fontWeight:700,color:P.mu,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:'0.4rem'}}>Escala lux</p>
                {CMAP.map((c,i)=>{
                  const lux=Math.round((i/(CMAP.length-1))*result.Emax)
                  const luxNext=i<CMAP.length-1?Math.round(((i+1)/(CMAP.length-1))*result.Emax):null
                  return(
                    <div key={i} style={{display:'flex',alignItems:'center',gap:'0.3rem',marginBottom:'0.2rem'}}>
                      <div style={{width:'14px',height:'10px',borderRadius:'2px',flexShrink:0,
                        background:`rgb(${c[0]},${c[1]},${c[2]})`,border:`1px solid ${P.border}`}}/>
                      <span style={{fontSize:'0.57rem',color:P.mu2}}>
                        {lux}{luxNext!==null?` – ${luxNext}`:'+'}
                        <span style={{color:P.mu,marginLeft:'0.2rem'}}>lx</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          ):(
            <div style={{textAlign:'center',marginTop:'2rem',color:P.mu}}>
              <i className="bi bi-lightbulb" style={{fontSize:'2rem',display:'block',marginBottom:'0.5rem'}}/>
              <p style={{fontSize:'0.7rem',lineHeight:1.5}}>Agrega luminarias y presiona <strong style={{color:P.gr}}>Calcular</strong></p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

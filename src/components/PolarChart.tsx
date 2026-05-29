import type { LightSource } from '../engine/types'
import { getCandelaDistribution, sourceName } from '../engine/lightingEngine'

export default function PolarChart({ source }: { source: LightSource }) {
  const dist = getCandelaDistribution(source)
  const S = 180, cx = S/2, cy = S/2, R = S/2 - 20
  const maxI = Math.max(...dist) || 1

  const pts = (side: 1 | -1) => Array.from({ length: 91 }, (_, g) => {
    const intens = dist[g] / maxI * R
    const rad = (g * Math.PI) / 180
    return `${cx + side * intens * Math.sin(rad)},${cy - intens * Math.cos(rad)}`
  })
  const path = `M ${pts(1).join(' L ')} L ${[...pts(-1)].reverse().join(' L ')} Z`

  return (
    <div>
      <svg width={S} height={S} style={{ display:'block', margin:'0 auto' }}>
        {[0.25, 0.5, 0.75, 1].map(f =>
          <circle key={f} cx={cx} cy={cy} r={f*R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={1}/>
        )}
        {[0, 30, 60, 90].map(g => {
          const rad = g*Math.PI/180
          return <g key={g}>
            <line x1={cx} y1={cy} x2={cx+R*Math.sin(rad)} y2={cy-R*Math.cos(rad)} stroke="rgba(255,255,255,0.06)" strokeWidth={1}/>
            {g > 0 && <line x1={cx} y1={cy} x2={cx-R*Math.sin(rad)} y2={cy-R*Math.cos(rad)} stroke="rgba(255,255,255,0.06)" strokeWidth={1}/>}
            <text x={cx+R*Math.sin(rad)+4} y={cy-R*Math.cos(rad)+3} fontSize={8} fill="#475569">{g}°</text>
          </g>
        })}
        <path d={path} fill="rgba(37,99,235,0.2)" stroke="#2563eb" strokeWidth={1.5}/>
        <circle cx={cx} cy={cy} r={3} fill="#60a5fa"/>
        <text x={cx} y={cy-R-6} textAnchor="middle" fontSize={8} fill="#475569">0°</text>
        <text x={cx} y={S-2} textAnchor="middle" fontSize={8} fill="#64748b">{Math.round(maxI)} cd max</text>
      </svg>
      <p style={{ fontSize:'0.68rem', color:'#64748b', textAlign:'center', marginTop:'4px' }}>
        {sourceName(source)}
      </p>
    </div>
  )
}

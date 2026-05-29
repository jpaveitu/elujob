// @ts-nocheck — archivo legacy, reemplazado por Simulador.tsx
// ============================================================
//  ELUX — Canvas interactivo 2D (vista en planta)
//  Heatmap + isolíneas + luminarias arrastrables
// ============================================================

import { useRef, useEffect, useCallback, useState } from 'react'
import { luxToRGB, bilinearSample, sourceName } from '../engine/lightingEngine'
import type { Luminaire, Room, CalcResult, Tool } from '../engine/types'

interface Props {
  room: Room
  luminaires: Luminaire[]
  result: CalcResult | null
  tool: Tool
  selectedId: string | null
  showHeatmap: boolean
  showIsolines: boolean
  showGrid: boolean
  showValues: boolean
  onAddLuminaire: (x: number, y: number) => void
  onMoveLuminaire: (id: string, x: number, y: number) => void
  onSelectLuminaire: (id: string | null) => void
  onDeleteLuminaire: (id: string) => void
}

const CANVAS_PX = 620   // ancho del canvas en px

export default function RoomCanvas({
  room, luminaires, result, tool,
  selectedId, showHeatmap, showIsolines, showGrid, showValues,
  onAddLuminaire, onMoveLuminaire, onSelectLuminaire, onDeleteLuminaire,
}: Props) {
  const heatRef  = useRef<HTMLCanvasElement>(null)
  const isoRef   = useRef<HTMLCanvasElement>(null)
  const uiRef    = useRef<HTMLCanvasElement>(null)

  const scale    = CANVAS_PX / room.length          // px/m
  const canvasH  = Math.round(CANVAS_W() * room.width / room.length)

  function CANVAS_W() { return CANVAS_PX }

  const [dragging, setDragging] = useState<string | null>(null)
  const dragOffset = useRef<{dx:number, dy:number}>({dx:0, dy:0})

  // ── Coordenadas canvas → metros ───────────────────────────
  const toMeters = useCallback((cx: number, cy: number) => ({
    x: Math.max(0, Math.min(room.length, cx / scale)),
    y: Math.max(0, Math.min(room.width,  cy / scale)),
  }), [scale, room])

  const getLumAt = useCallback((cx: number, cy: number): Luminaire | null => {
    const R = 12 / scale   // radio de detección en metros
    for (const lum of luminaires) {
      const dx = lum.x - cx / scale
      const dy = lum.y - cy / scale
      if (Math.sqrt(dx*dx + dy*dy) < R) return lum
    }
    return null
  }, [luminaires, scale])

  // ── Dibujar heatmap ───────────────────────────────────────
  useEffect(() => {
    const canvas = heatRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height

    if (!result || !showHeatmap) {
      ctx.fillStyle = '#0d1117'
      ctx.fillRect(0, 0, W, H)
      // Cuadrícula de fondo
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      const step = scale   // cada metro
      for (let x = 0; x <= W; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke() }
      for (let y = 0; y <= H; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }
      return
    }

    const { grid, gridRows: GR, gridCols: GC, Emax } = result
    const scale2 = Emax * 1.05 || 1

    const img = ctx.createImageData(W, H)
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const [r,g,b] = luxToRGB(
          bilinearSample(grid, GR, GC, py/(H-1), px/(W-1)),
          scale2
        )
        const idx = (py*W+px)*4
        img.data[idx]=r; img.data[idx+1]=g; img.data[idx+2]=b; img.data[idx+3]=255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [result, showHeatmap, room, scale])

  // ── Dibujar isolíneas ─────────────────────────────────────
  useEffect(() => {
    const canvas = isoRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!result || !showIsolines) return

    for (const iso of result.isolines) {
      // Color de la isolínea según valor
      const t = iso.value / (result.Emax || 1)
      const bright = Math.round(80 + t * 175)
      ctx.strokeStyle = `rgba(${bright},${bright},${bright},0.75)`
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])

      for (const seg of iso.segments) {
        ctx.beginPath()
        ctx.moveTo(seg.x1 * scale, seg.y1 * scale)
        ctx.lineTo(seg.x2 * scale, seg.y2 * scale)
        ctx.stroke()
      }

      // Etiquetas de valor (cada N segmentos)
      if (iso.segments.length > 0) {
        const s = iso.segments[Math.floor(iso.segments.length / 2)]
        ctx.setLineDash([])
        ctx.font = 'bold 9px monospace'
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.fillText(`${iso.value} lx`, s.x1 * scale + 2, s.y1 * scale - 2)
      }
    }
    ctx.setLineDash([])
  }, [result, showIsolines, scale])

  // ── Dibujar UI (grid, luminarias, valores) ────────────────
  useEffect(() => {
    const canvas = uiRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)

    // Cuadrícula métrica
    if (showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 0.5
      ctx.setLineDash([2, 4])
      const step = scale
      for (let x = 0; x <= W; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke() }
      for (let y = 0; y <= H; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }
      // etiquetas metros
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.font = '9px monospace'
      for (let m = 1; m < room.length; m++)
        ctx.fillText(`${m}m`, m * scale + 2, 11)
      for (let m = 1; m < room.width; m++)
        ctx.fillText(`${m}m`, 2, m * scale - 2)
    }
    ctx.setLineDash([])

    // Valores puntales Em si se pide
    if (showValues && result) {
      ctx.font = 'bold 8px monospace'
      const cols = 8, rows = 6
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const lux = bilinearSample(
            result.grid, result.gridRows, result.gridCols,
            (r+0.5)/rows, (c+0.5)/cols
          )
          ctx.fillStyle = lux < result.Em * 0.7 ? '#f87171' : lux > result.Em * 1.3 ? '#34d399' : '#e2e8f0'
          ctx.fillText(lux.toFixed(0), (c+0.5)/cols*W - 12, (r+0.5)/rows*H + 4)
        }
      }
    }

    // Luminarias
    const R = 9
    for (const lum of luminaires) {
      const cx = lum.x * scale
      const cy = lum.y * scale
      const sel = lum.id === selectedId

      // Sombra / aura
      ctx.beginPath()
      ctx.arc(cx, cy, R + (sel ? 5 : 2), 0, Math.PI*2)
      ctx.fillStyle = sel ? 'rgba(99,102,241,0.25)' : 'rgba(250,204,21,0.12)'
      ctx.fill()

      // Círculo principal
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI*2)
      ctx.fillStyle = sel ? '#818cf8' : '#fbbf24'
      ctx.fill()
      ctx.strokeStyle = sel ? '#6366f1' : '#f59e0b'
      ctx.lineWidth = sel ? 2 : 1.5
      ctx.stroke()

      // Cruz
      ctx.beginPath()
      ctx.moveTo(cx-6,cy); ctx.lineTo(cx+6,cy)
      ctx.moveTo(cx,cy-6); ctx.lineTo(cx,cy+6)
      ctx.strokeStyle = sel ? '#c7d2fe' : 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 1.2
      ctx.stroke()

      // Tooltip con nombre
      if (sel) {
        const label = sourceName(lum.source).slice(0, 22)
        const tw = ctx.measureText(label).width + 10
        const tx = Math.min(cx - tw/2, W - tw - 2)
        const ty = cy - R - 18
        ctx.fillStyle = 'rgba(17,24,39,0.92)'
        ctx.beginPath()
        ctx.roundRect(tx, ty - 2, tw, 16, 4)
        ctx.fill()
        ctx.fillStyle = '#a5b4fc'
        ctx.font = '9px monospace'
        ctx.fillText(label, tx + 5, ty + 10)
      }
    }

    // Borde del recinto
    ctx.strokeStyle = '#4f46e5'
    ctx.lineWidth = 2
    ctx.strokeRect(0, 0, W, H)

    // Cursor según herramienta
    if (uiRef.current) {
      uiRef.current.style.cursor =
        tool === 'add' ? 'crosshair' :
        tool === 'delete' ? 'not-allowed' : 'default'
    }
  }, [luminaires, selectedId, showGrid, showValues, result, scale, room, tool])

  // ── Eventos del mouse ─────────────────────────────────────
  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = uiRef.current!.getBoundingClientRect()
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top }
  }

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { cx, cy } = getPos(e)
    const hit = getLumAt(cx, cy)

    if (tool === 'delete' && hit) {
      onDeleteLuminaire(hit.id)
      return
    }

    if (tool === 'add' && !hit) {
      const m = toMeters(cx, cy)
      onAddLuminaire(m.x, m.y)
      return
    }

    if (tool === 'select') {
      if (hit) {
        onSelectLuminaire(hit.id)
        setDragging(hit.id)
        dragOffset.current = { dx: cx / scale - hit.x, dy: cy / scale - hit.y }
      } else {
        onSelectLuminaire(null)
      }
    }
  }, [tool, getLumAt, scale, toMeters, onAddLuminaire, onSelectLuminaire, onDeleteLuminaire])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging) return
    const { cx, cy } = getPos(e)
    const nx = Math.max(0, Math.min(room.length, cx / scale - dragOffset.current.dx))
    const ny = Math.max(0, Math.min(room.width,  cy / scale - dragOffset.current.dy))
    onMoveLuminaire(dragging, nx, ny)
  }, [dragging, scale, room, onMoveLuminaire])

  const onMouseUp = useCallback(() => setDragging(null), [])

  const H = canvasH

  return (
    <div style={{ position: 'relative', width: CANVAS_PX, height: H, flexShrink: 0 }}>
      {/* Capa 1: heatmap */}
      <canvas ref={heatRef} width={CANVAS_PX} height={H}
        style={{ position:'absolute', top:0, left:0, borderRadius:'4px' }}/>
      {/* Capa 2: isolíneas */}
      <canvas ref={isoRef} width={CANVAS_PX} height={H}
        style={{ position:'absolute', top:0, left:0 }}/>
      {/* Capa 3: UI interactiva */}
      <canvas ref={uiRef} width={CANVAS_PX} height={H}
        style={{ position:'absolute', top:0, left:0 }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      />
    </div>
  )
}

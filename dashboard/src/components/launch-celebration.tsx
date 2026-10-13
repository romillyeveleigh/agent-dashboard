'use client'

import { createContext, useContext, useCallback, useRef, useEffect } from 'react'

// ── Particle physics ────────────────────────────────────────────────
interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  color: string
  size: number
  gravity: number
  drag: number
  sparkle: boolean
}

interface Burst {
  x: number
  y: number
  particles: Particle[]
  delay: number
}

const PALETTE = [
  '#2563eb', // accent blue
  '#3b82f6', // lighter blue
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#ec4899', // pink
  '#fbbf24', // yellow
]

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function createBurst(x: number, y: number, count: number): Particle[] {
  const particles: Particle[] = []
  for (let i = 0; i < count; i++) {
    // Upward fan from bottom edge — small sparks, big spread
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2
    const speed = 2 + Math.random() * 5
    const life = 120 + Math.random() * 100
    particles.push({
      x: x + (Math.random() - 0.5) * 80,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      color: randomFrom(PALETTE),
      size: 1.2 + Math.random() * 1.3,
      gravity: 0.02 + Math.random() * 0.015,
      drag: 0.99,
      sparkle: Math.random() > 0.5,
    })
  }
  return particles
}

// ── Context ─────────────────────────────────────────────────────────
const CelebrationContext = createContext<{ celebrate: () => void }>({
  celebrate: () => {},
})

export function useCelebration() {
  return useContext(CelebrationContext)
}

// ── Provider + Canvas ───────────────────────────────────────────────
export function CelebrationProvider({ children }: { children: React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const burstsRef = useRef<Burst[]>([])

  useEffect(() => {
    return () => cancelAnimationFrame(animRef.current)
  }, [])

  const animate = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    let alive = false
    const now = performance.now()

    for (const burst of burstsRef.current) {
      if (burst.delay > 0) {
        burst.delay--
        alive = true
        continue
      }

      for (const p of burst.particles) {
        if (p.life <= 0) continue
        alive = true

        p.vx *= p.drag
        p.vy *= p.drag
        p.vy += p.gravity
        p.x += p.vx
        p.y += p.vy
        p.life--

        const alpha = p.life / p.maxLife
        ctx.globalAlpha = alpha * 0.9

        // Sparkle effect
        if (p.sparkle && Math.sin(now * 0.015 + p.x) > 0.3) {
          ctx.globalAlpha = alpha * 0.5
        }

        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size * (0.5 + alpha * 0.5), 0, Math.PI * 2)
        ctx.fill()

        // Trail
        if (alpha > 0.3) {
          ctx.globalAlpha = alpha * 0.35
          ctx.beginPath()
          ctx.arc(p.x - p.vx * 2, p.y - p.vy * 2, p.size * 0.4, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    ctx.globalAlpha = 1

    if (alive) {
      animRef.current = requestAnimationFrame(animate)
    } else {
      burstsRef.current = []
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [])

  const celebrate = useCallback(() => {
    const w = window.innerWidth
    const h = window.innerHeight
    const bottom = h - 4

    // Bursts across the full bottom edge
    const bursts: Burst[] = [
      { x: w * 0.1, y: bottom, particles: createBurst(w * 0.1, bottom, 50), delay: 0 },
      { x: w * 0.3, y: bottom, particles: createBurst(w * 0.3, bottom, 60), delay: 6 },
      { x: w * 0.5, y: bottom, particles: createBurst(w * 0.5, bottom, 60), delay: 12 },
      { x: w * 0.7, y: bottom, particles: createBurst(w * 0.7, bottom, 60), delay: 18 },
      { x: w * 0.9, y: bottom, particles: createBurst(w * 0.9, bottom, 50), delay: 24 },
      { x: w * 0.2, y: bottom, particles: createBurst(w * 0.2, bottom, 40), delay: 32 },
      { x: w * 0.55, y: bottom, particles: createBurst(w * 0.55, bottom, 40), delay: 38 },
      { x: w * 0.8, y: bottom, particles: createBurst(w * 0.8, bottom, 40), delay: 44 },
    ]

    burstsRef.current = bursts
    cancelAnimationFrame(animRef.current)
    animRef.current = requestAnimationFrame(animate)
  }, [animate])

  return (
    <CelebrationContext.Provider value={{ celebrate }}>
      {children}
      <canvas
        ref={canvasRef}
        className="fixed inset-0 z-[100] pointer-events-none"
        aria-hidden="true"
      />
    </CelebrationContext.Provider>
  )
}

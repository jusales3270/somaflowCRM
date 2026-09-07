'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface ThreeDMarqueeProps {
  className?: string
}

// Telas reais do CRM SomaFlow
const crmScreens: string[] = [
  '/previews/inbox.png',
  '/previews/radar.png',
  '/previews/agenda.png',
  '/previews/funis.png',
  '/previews/crm-hub.png',
]

export function ThreeDMarquee({ className }: ThreeDMarqueeProps) {
  // 4 filas de prints conforme solicitado
  const numColumns = 4

  const columnsData = Array.from({ length: numColumns }, (_, colIndex) => {
    // Intercala o ponto inicial para garantir variedade entre as filas
    const rotatedScreens = crmScreens.map((_, i) => {
      const idx = (i + colIndex * 2) % crmScreens.length
      return crmScreens[idx] ?? crmScreens[0]
    })
    // 3 repetições para loop suave e contínuo sem saltos
    return [...rotatedScreens, ...rotatedScreens, ...rotatedScreens]
  })

  return (
    <div
      className={cn(
        'absolute inset-0 size-full overflow-hidden select-none pointer-events-none flex items-center justify-center',
        className
      )}
    >
      {/* Container amplo com perspectiva 3D isométrica diagonal (estilo referência) */}
      <div className='relative w-[170vw] min-w-[1500px] h-[180vh] flex items-center justify-center overflow-hidden'>
        <div
          style={{
            transform: 'perspective(1200px) rotateX(32deg) rotateY(8deg) rotateZ(32deg) scale(1.15)',
            transformStyle: 'preserve-3d',
          }}
          className='w-full grid grid-cols-4 gap-7 md:gap-9 justify-center items-center'
        >
          {columnsData.map((columnImages, colIndex) => {
            // Scrolling alternado entre as 4 filas com velocidade 20% menor (mais sereno e contemplativo)
            const isScrollDown = colIndex % 2 === 0
            const duration = 43 + (colIndex % 2) * 6

            return (
              <div
                key={colIndex + 'column'}
                className='relative flex flex-col items-center overflow-hidden'
                style={{ transformStyle: 'preserve-3d' }}
              >
                <motion.div
                  animate={{
                    y: isScrollDown ? ['-33.333%', '0%'] : ['0%', '-33.333%'],
                  }}
                  transition={{
                    duration,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                  className='flex flex-col gap-7 md:gap-9 will-change-transform w-full'
                  style={{ transformStyle: 'preserve-3d' }}
                >
                  {columnImages.map((src, imgIdx) => (
                    <div
                      key={`${colIndex}-${imgIdx}-${src}`}
                      style={{
                        transform: 'translateZ(18px)',
                        boxShadow:
                          '0 28px 50px -12px rgba(0, 0, 0, 0.28), 0 16px 24px -10px rgba(0, 0, 0, 0.18)',
                      }}
                      className='relative w-full overflow-hidden rounded-2xl border border-white/80 bg-white/95 ring-1 ring-black/5 transition-all duration-300 dark:border-white/15 dark:bg-zinc-900/95 dark:ring-white/10'
                    >
                      {/* Mini barra de janela estilo Mac com profundidade */}
                      <div className='flex items-center gap-1.5 px-3.5 py-2 bg-zinc-100/95 border-b border-zinc-200/80 dark:bg-zinc-800/90 dark:border-zinc-700/80'>
                        <span className='size-2.5 rounded-full bg-rose-400/90 inline-block shadow-xs' />
                        <span className='size-2.5 rounded-full bg-amber-400/90 inline-block shadow-xs' />
                        <span className='size-2.5 rounded-full bg-emerald-400/90 inline-block shadow-xs' />
                        <div className='ml-2 h-2 w-20 rounded-full bg-zinc-200/70 dark:bg-zinc-700/70' />
                      </div>

                      {/* Print nítido e ampliado do CRM */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        className='aspect-16/10 w-full object-cover object-top select-none'
                        src={src}
                        draggable={false}
                        alt={`Interface CRM ${imgIdx + 1}`}
                        loading='eager'
                      />
                    </div>
                  ))}
                </motion.div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default ThreeDMarquee

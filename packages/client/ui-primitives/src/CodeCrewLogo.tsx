import type { IconProps } from './icons/props.ts'

/**
 * Render CodeCrew’s code brackets and connected AI nodes in the surrounding ink.
 * @param props.size - Square edge in pixels; defaults to 24.
 * @param props.className - Optional layout class.
 * @returns Decorative mark; pair it with the product name for an accessible label.
 */
export function CodeCrewLogo({ size = 24, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <path d="M9 9 2.5 16 9 23M23 9 29.5 16 23 23M12.5 24 19.5 8" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      <g fill="currentColor">
        <circle cx={12.5} cy={24} r={2.6} />
        <circle cx={16} cy={16} r={2.6} />
        <circle cx={19.5} cy={8} r={2.6} />
      </g>
    </svg>
  )
}

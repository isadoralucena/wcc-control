/** Balão desenhado em SVG, colorido com a cor da questão. */
interface Props {
  color: string;
  size?: number;
  muted?: boolean;
  className?: string;
}

export function Balloon({ color, size = 24, muted = false, className = '' }: Props) {
  return (
    <svg viewBox="0 0 24 34" width={(size * 24) / 34} height={size} className={`balloon ${className}`} aria-hidden>
      <path d="M12 1.5c5.8 0 10 4.5 10 10.2 0 6.6-5.3 11.6-8.6 12.9h-2.8C7.3 23.3 2 18.3 2 11.7 2 6 6.2 1.5 12 1.5Z" fill={muted ? 'transparent' : color} stroke={muted ? 'currentColor' : 'rgba(0,0,0,.18)'} strokeWidth={muted ? 1.5 : 1} />
      <path d="M10.6 24.6h2.8l.9 2.1h-4.6z" fill={muted ? 'currentColor' : color} />
      <path d="M12 26.7c-1.6 2.2 1.6 3.4 0 6" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".55" />
      {!muted && <ellipse cx="8.2" cy="8.3" rx="2.1" ry="3.3" transform="rotate(-25 8.2 8.3)" fill="#fff" opacity=".35" />}
    </svg>
  );
}

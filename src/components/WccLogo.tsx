/**
 * Logo oficial do WCC: usa o próprio arquivo public/favicon.svg (o mesmo da aba
 * do navegador), sem redesenho. O arquivo é quadrado (2000×2000) e a estrela
 * ocupa toda a área, então basta definir o lado.
 *
 * `import.meta.env.BASE_URL` respeita o `base` do Vite, funcionando em
 * qualquer subcaminho do GitHub Pages.
 */
export const LOGO_URL = `${import.meta.env.BASE_URL}favicon.svg`;

interface Props {
  size?: number;
  className?: string;
  /** Gira enquanto há uma consulta em andamento. */
  spin?: boolean;
  /** Texto alternativo; omitido = decorativo (aria-hidden). */
  alt?: string;
}

export function WccLogo({ size = 32, className = '', spin = false, alt }: Props) {
  return (
    <img
      src={LOGO_URL}
      width={size}
      height={size}
      alt={alt ?? ''}
      aria-hidden={alt ? undefined : true}
      draggable={false}
      decoding="async"
      className={`wcc-logo ${spin ? 'wcc-logo--spin' : ''} ${className}`}
    />
  );
}

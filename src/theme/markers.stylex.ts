import * as stylex from '@stylexjs/stylex'

// Ancestor markers for the vendored shadcn descendant rules (`[&_svg]:…`).
// A component applies a marker via `stylex.props(marker)`; the icon styles in
// src/components/icons.tsx read it back with `stylex.when.ancestor(…)`, which
// is how StyleX expresses "every svg inside a button is 16px and inert"
// without a descendant selector.

/** `[&_svg]:pointer-events-none [&_svg]:shrink-0` — Button, Toggle, SelectTrigger, SelectItem. */
export const svgHost = stylex.defineMarker()
/** `[&_svg:not([class*='size-'])]:size-3` — Button xs / icon-xs. */
export const svgSize3 = stylex.defineMarker()
/** `[&_svg:not([class*='size-'])]:size-3.5` — Button sm / icon-sm, Toggle sm. */
export const svgSize35 = stylex.defineMarker()
/** `[&_svg:not([class*='size-'])]:size-4` — Button default/lg/icon/icon-lg, Toggle, SelectTrigger, SelectItem, select scroll arrows. */
export const svgSize4 = stylex.defineMarker()
/** Badge: `[&>svg]:pointer-events-none [&>svg]:size-3!` — the `!important` is not carried; an
 *  explicit `sx` size on the icon replaces these rules wholesale anyway. */
export const badgeSvg = stylex.defineMarker()

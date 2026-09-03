import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { cn, type ClassValue } from 'cn'

// --- Implementations ---

// 1. Official shadcn cn engine (from 'cn' package)
const cnOfficial = cn

// 2. Fast-Path cn (direct return for single strings, full cn merge for multiple/conditionals)
function cnFastPath(...inputs: ClassValue[]): string {
  if (inputs.length === 1 && typeof inputs[0] === 'string') {
    return inputs[0]
  }
  return cn(...inputs)
}

// 3. StyleX props resolution simulation (O(1) object key override, compile-time atomic classes)
interface StyleXAtomicObj {
  [propertyKey: string]: string
}
function stylexProps(...styles: (StyleXAtomicObj | boolean | null | undefined)[]): { className: string } {
  let classList = ''
  const resolved: Record<string, string> = {}
  for (let i = 0; i < styles.length; i++) {
    const s = styles[i]
    if (!s || typeof s !== 'object') continue
    for (const k in s) {
      const val = s[k]
      if (typeof val === 'string') {
        resolved[k] = val
      }
    }
  }
  for (const k in resolved) {
    if (classList) classList += ' '
    classList += resolved[k]
  }
  return { className: classList }
}

// --- Benchmark Runner ---

function bench(_name: string, fn: () => void, iterations: number = 100_000): { opsPerSec: number; totalMs: number; nsPerOp: number } {
  for (let i = 0; i < 5_000; i++) fn()

  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    fn()
  }
  const end = performance.now()
  const totalMs = end - start
  const opsPerSec = Math.round((iterations / totalMs) * 1000)
  const nsPerOp = Math.round((totalMs * 1_000_000) / iterations)
  return { opsPerSec, totalMs, nsPerOp }
}

// Scenarios
const testCases = [
  {
    name: '1. Single String (Base classes)',
    officialCn: () => cnOfficial('group/button inline-flex shrink-0 items-center justify-center rounded-lg border text-sm font-medium'),
    fastPathCn: () => cnFastPath('group/button inline-flex shrink-0 items-center justify-center rounded-lg border text-sm font-medium'),
    stylex: () => stylexProps({ display: 'x-inline-flex', align: 'x-items-center', radius: 'x-rounded-lg', font: 'x-text-sm' }),
  },
  {
    name: '2. Conditional classes (Dynamic state)',
    officialCn: () => {
      const isActive = Number(Date.now()) > 0
      const isDisabled = Number(Date.now()) < 0
      return cnOfficial('btn', isActive && 'btn-active', isDisabled && 'btn-disabled', 'px-2')
    },
    fastPathCn: () => {
      const isActive = Number(Date.now()) > 0
      const isDisabled = Number(Date.now()) < 0
      return cnFastPath('btn', isActive && 'btn-active', isDisabled && 'btn-disabled', 'px-2')
    },
    stylex: () => {
      const isActive = Number(Date.now()) > 0
      const isDisabled = Number(Date.now()) < 0
      return stylexProps({ base: 'x-btn' }, isActive && { active: 'x-active' }, isDisabled && { disabled: 'x-disabled' }, { px: 'x-px2' })
    },
  },
  {
    name: '3. Component Override (Conflict resolution)',
    officialCn: () => cnOfficial('px-2.5 py-1.5 bg-primary text-primary-foreground', 'px-4 bg-destructive'),
    fastPathCn: () => cnFastPath('px-2.5 py-1.5 bg-primary text-primary-foreground', 'px-4 bg-destructive'),
    stylex: () => stylexProps({ px: 'x-px2.5', py: 'x-py1.5', bg: 'x-bg-prim', fg: 'x-fg-prim' }, { px: 'x-px4', bg: 'x-bg-dest' }),
  },
  {
    name: '4. Complex Multi-Variant (Button CVA simulation)',
    officialCn: () => cnOfficial(
      'group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap',
      'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted',
      'h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem]',
      'px-3 bg-red-600'
    ),
    fastPathCn: () => cnFastPath(
      'group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap',
      'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted',
      'h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem]',
      'px-3 bg-red-600'
    ),
    stylex: () => stylexProps(
      { baseDisplay: 'x-inline-flex', baseAlign: 'x-items-center', baseRadius: 'x-rounded-lg', baseText: 'x-text-sm' },
      { varBorder: 'x-border-border', varBg: 'x-bg-background', varHover: 'x-hover-muted' },
      { sizeH: 'x-h7', sizeGap: 'x-gap1', sizePx: 'x-px2.5' },
      { overridePx: 'x-px3', overrideBg: 'x-bg-red' }
    ),
  },
]

console.log('=== RUNTIME PERFORMANCE BENCHMARK (100,000 iterations each) ===\n')

for (const tc of testCases) {
  console.log(`--- ${tc.name} ---`)
  const rOfficial = bench('new official cn', tc.officialCn)
  const rFastPath = bench('fast-path cn', tc.fastPathCn)
  const rStylex = bench('StyleX (props simulation)', tc.stylex)

  console.log(`  1. Official shadcn cn (cn@0.2.4) : ${rOfficial.opsPerSec.toLocaleString()} ops/s  (${rOfficial.nsPerOp} ns/op)`)
  console.log(`  2. Fast-Path cn (single-string fast) : ${rFastPath.opsPerSec.toLocaleString()} ops/s  (${rFastPath.nsPerOp} ns/op)`)
  console.log(`  3. StyleX Atomic Props               : ${rStylex.opsPerSec.toLocaleString()} ops/s  (${rStylex.nsPerOp} ns/op)`)
  console.log()
}

// Verification that outputs match
console.log('=== OUTPUT CORRECTNESS VERIFICATION ===')
const sampleConflict = ['px-2 py-1 bg-primary text-white', 'px-4 bg-secondary']
console.log('Input:', sampleConflict)
console.log('  official cn :', cnOfficial(...sampleConflict))
console.log('  fast path   :', cnFastPath(...sampleConflict))
console.log()

// --- Bundle Size Analysis ---
console.log('=== MODULE BUNDLE SIZE FOOTPRINT (minified & gzipped) ===')

function getPkgSize(path: string): { raw: number; gzip: number } {
  try {
    const buf = readFileSync(path)
    return {
      raw: buf.length,
      gzip: gzipSync(buf).length,
    }
  } catch {
    return { raw: 0, gzip: 0 }
  }
}

const modules = [
  { name: 'official cn (dist/engine.js)', path: 'node_modules/cn/dist/engine.js' },
  { name: 'official cn (dist/tables.js)', path: 'node_modules/cn/dist/tables.js' },
  { name: 'class-variance-authority (dist/index.mjs)', path: 'node_modules/class-variance-authority/dist/index.mjs' },
  { name: 'clsx (dist/clsx.mjs)', path: 'node_modules/clsx/dist/clsx.mjs' },
]

for (const m of modules) {
  const size = getPkgSize(m.path)
  console.log(`  ${m.name.padEnd(45)}: ${(size.raw / 1024).toFixed(2).padStart(6)} kB raw | ${(size.gzip / 1024).toFixed(2).padStart(5)} kB gzip`)
}

console.log()

console.log('=== CHROME EXTENSION BUILD OUTPUT METRICS (.output/chrome-mv3) ===\n')

interface FileMetric {
  relPath: string
  rawBytes: number
  gzipBytes: number
}

function scanDir(dir: string, base: string = dir): FileMetric[] {
  const results: FileMetric[] = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        results.push(...scanDir(full, base))
      } else {
        const buf = readFileSync(full)
        results.push({
          relPath: full.slice(base.length + 1),
          rawBytes: buf.length,
          gzipBytes: gzipSync(buf).length,
        })
      }
    }
  } catch {
    // directory might not exist yet
  }
  return results
}

const buildFiles = scanDir('.output/chrome-mv3')
if (buildFiles.length > 0) {
  let totalJsRaw = 0
  let totalJsGzip = 0
  let totalCssRaw = 0
  let totalCssGzip = 0
  let grandRaw = 0
  let grandGzip = 0

  console.log('--- Key Bundles Breakdown ---')
  for (const f of buildFiles) {
    grandRaw += f.rawBytes
    grandGzip += f.gzipBytes
    if (f.relPath.endsWith('.js')) {
      totalJsRaw += f.rawBytes
      totalJsGzip += f.gzipBytes
    } else if (f.relPath.endsWith('.css')) {
      totalCssRaw += f.rawBytes
      totalCssGzip += f.gzipBytes
    }
    console.log(`  ${f.relPath.padEnd(45)}: ${(f.rawBytes / 1024).toFixed(2).padStart(6)} kB raw | ${(f.gzipBytes / 1024).toFixed(2).padStart(5)} kB gzip`)
  }

  console.log('\n--- Totals by Category ---')
  console.log(`  Total JavaScript: ${(totalJsRaw / 1024).toFixed(2).padStart(6)} kB raw | ${(totalJsGzip / 1024).toFixed(2).padStart(5)} kB gzip`)
  console.log(`  Total CSS       : ${(totalCssRaw / 1024).toFixed(2).padStart(6)} kB raw | ${(totalCssGzip / 1024).toFixed(2).padStart(5)} kB gzip`)
  console.log(`  Grand Total     : ${(grandRaw / 1024).toFixed(2).padStart(6)} kB raw | ${(grandGzip / 1024).toFixed(2).padStart(5)} kB gzip`)

  const appCssFile = buildFiles.find(f => f.relPath.startsWith('assets/app-') && f.relPath.endsWith('.css'))
  if (appCssFile) {
    const cssContent = readFileSync(`.output/chrome-mv3/${appCssFile.relPath}`, 'utf8')
    console.log('\n--- Tailwind CSS (app.css) Content Composition ---')
    console.log(`  Total app.css size       : ${(appCssFile.rawBytes / 1024).toFixed(2)} kB (${appCssFile.gzipBytes / 1024} kB gzip)`)
    const hasPreflight = cssContent.includes('box-sizing') || cssContent.includes('border-box')
    const hasTwAnimate = cssContent.includes('keyframes') || cssContent.includes('@keyframes')
    const hasTokens = cssContent.includes('--xmd-') || cssContent.includes('oklch')
    console.log(`  Contains Preflight Reset : ${hasPreflight}`)
    console.log(`  Contains Keyframe Motion : ${hasTwAnimate}`)
    console.log(`  Contains OKLCH tokens    : ${hasTokens}`)
  }
} else {
  console.log('No build output found in .output/chrome-mv3. Run bun run build first.')
}

console.log()

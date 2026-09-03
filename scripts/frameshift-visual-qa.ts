import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

interface Checkpoint {
  name: string
  urlPath: string
  width: number
  height: number
}

const CHECKPOINTS: Checkpoint[] = [
  { name: 'options__saving', urlPath: 'options.html#saving', width: 1200, height: 800 },
  { name: 'options__archive', urlPath: 'options.html#archive', width: 1200, height: 800 },
  { name: 'options__sync', urlPath: 'options.html#sync', width: 1200, height: 800 },
  { name: 'popup__main', urlPath: 'popup.html', width: 420, height: 620 },
]

async function getCDPOptionsTarget(): Promise<{ wsUrl: string; extBaseUrl: string }> {
  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const optTarget = targets.find((t: { url?: string; type?: string }) =>
    t.type === 'page' && t.url && t.url.includes('chrome-extension://') && (t.url.includes('options.html') || t.url.includes('popup.html'))
  )
  if (!optTarget) {
    throw new Error('Could not find extension page target on CDP port 9222. Ensure Chrome extension is running.')
  }
  const match = optTarget.url.match(/chrome-extension:\/\/[a-z0-9]+/i)
  const extBaseUrl = match ? match[0] : ''
  return { wsUrl: optTarget.webSocketDebuggerUrl, extBaseUrl }
}

class CDPClient {
  private ws: WebSocket
  private id = 1
  private pending = new Map<number, (res: unknown) => void>()

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl)
  }

  async connect(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.ws.addEventListener('open', () => resolve(), { once: true })
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data as string)
      if (msg.id && this.pending.has(msg.id)) {
        const cb = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        cb(msg.result)
      }
    })
    return promise
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const { promise, resolve } = Promise.withResolvers<any>()
    const curId = this.id++
    this.pending.set(curId, resolve)
    this.ws.send(JSON.stringify({ id: curId, method, params }))
    return promise
  }

  close() {
    this.ws.close()
  }
}

async function captureCheckpoints(mode: 'baseline' | 'candidate'): Promise<void> {
  const { wsUrl, extBaseUrl } = await getCDPOptionsTarget()
  const client = new CDPClient(wsUrl)
  await client.connect()

  const outDir = `test-output/frameshift/${mode}`
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

  await client.send('Page.enable')

  for (const cp of CHECKPOINTS) {
    const targetUrl = `${extBaseUrl}/${cp.urlPath}`
    console.log(`[${mode}] Capturing ${cp.name} -> ${targetUrl}`)

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: cp.width,
      height: cp.height,
      deviceScaleFactor: 2,
      mobile: false,
    })

    await client.send('Page.navigate', { url: targetUrl })
    // Deterministic wait: poll until all loading placeholders are gone and layout is settled
    await client.send('Runtime.evaluate', {
      expression: `
        new Promise(resolve => {
          const start = Date.now();
          const check = () => {
            const loading = document.querySelector('.xmd-boot-fallback') || document.querySelector('.xmd-popup--loading');
            if (!loading || Date.now() - start > 3000) {
              setTimeout(resolve, 300);
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        })
      `,
      awaitPromise: true,
    })
    const ss = await client.send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(ss.data, 'base64')
    writeFileSync(`${outDir}/${cp.name}.png`, buf)
  }

  // Restore options saving default
  await client.send('Page.navigate', { url: `${extBaseUrl}/options.html#saving` })
  const { promise: navPromise, resolve: navResolve } = Promise.withResolvers<void>()
  setTimeout(navResolve, 300)
  await navPromise
  client.close()
}

interface DiffResult {
  name: string
  status: 'unchanged' | 'changed' | 'added' | 'removed'
  diffPixels: number
  diffRatio: number
  totalPixels: number
  dimensions: { width: number; height: number }
}

function compareSnapshots(): DiffResult[] {
  const baseDir = 'test-output/frameshift/baseline'
  const candDir = 'test-output/frameshift/candidate'
  const diffDir = 'test-output/frameshift/diff'
  if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true })

  const results: DiffResult[] = []

  for (const cp of CHECKPOINTS) {
    const basePath = `${baseDir}/${cp.name}.png`
    const candPath = `${candDir}/${cp.name}.png`
    const diffPath = `${diffDir}/${cp.name}.png`

    if (!existsSync(basePath) || !existsSync(candPath)) {
      console.warn(`Skipping ${cp.name}: missing files`)
      continue
    }

    const img1 = PNG.sync.read(readFileSync(basePath))
    const img2 = PNG.sync.read(readFileSync(candPath))

    const width = Math.max(img1.width, img2.width)
    const height = Math.max(img1.height, img2.height)
    const diff = new PNG({ width, height })

    const numDiffPixels = pixelmatch(
      img1.data,
      img2.data,
      diff.data,
      width,
      height,
      {
        threshold: 0.1,
        diffColor: [253, 141, 104], // Frameshift signature coral
      }
    )

    writeFileSync(diffPath, PNG.sync.write(diff))

    const totalPixels = width * height
    const diffRatio = totalPixels > 0 ? numDiffPixels / totalPixels : 0
    const status = numDiffPixels === 0 ? 'unchanged' : 'changed'

    results.push({
      name: cp.name,
      status,
      diffPixels: numDiffPixels,
      diffRatio,
      totalPixels,
      dimensions: { width, height },
    })
  }

  return results
}

function generateFrameshiftReport(results: DiffResult[]): void {
  const report = {
    version: 'frameshift-report-v2',
    timestamp: new Date().toISOString(),
    tool: 'frameshift-visual-diff-workflow',
    summary: {
      total: results.length,
      unchanged: results.filter(r => r.status === 'unchanged').length,
      changed: results.filter(r => r.status === 'changed').length,
      added: results.filter(r => r.status === 'added').length,
      removed: results.filter(r => r.status === 'removed').length,
    },
    screens: results.map(r => ({
      name: r.name,
      status: r.status,
      diffPixels: r.diffPixels,
      diffPercentage: (r.diffRatio * 100).toFixed(3) + '%',
      dimensions: r.dimensions,
      baselineImage: `baseline/${r.name}.png`,
      candidateImage: `candidate/${r.name}.png`,
      diffImage: `diff/${r.name}.png`,
    })),
  }

  writeFileSync('test-output/frameshift/report.json', JSON.stringify(report, null, 2))

  // Generate self-contained HTML visualizer
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Frameshift Visual Comparison Report</title>
  <style>
    :root {
      --bg: #09090b;
      --card: #18181b;
      --border: #27272a;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --accent: #fd8d68;
      --success: #22c55e;
    }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
    }
    h1 { font-size: 20px; margin-bottom: 8px; }
    .meta { font-size: 13px; color: var(--text-muted); margin-bottom: 24px; }
    .summary-bar {
      display: flex; gap: 16px; margin-bottom: 24px; padding: 12px 16px;
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 9999px;
      font-size: 12px; font-weight: 600;
    }
    .badge-unchanged { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge-changed { background: rgba(253, 141, 104, 0.2); color: var(--accent); }
    .card {
      background: var(--card); border: 1px solid var(--border); border-radius: 10px;
      margin-bottom: 24px; overflow: hidden;
    }
    .card-header {
      padding: 12px 16px; display: flex; justify-content: space-between;
      align-items: center; border-bottom: 1px solid var(--border);
    }
    .grid-images {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding: 16px;
    }
    .img-box { text-align: center; }
    .img-box h3 { font-size: 12px; color: var(--text-muted); margin: 0 0 8px 0; }
    .img-box img { max-width: 100%; border-radius: 6px; border: 1px solid var(--border); }
  </style>
</head>
<body>
  <h1>Frameshift Visual Comparison Report</h1>
  <div class="meta">Generated: ${report.timestamp} | Extension ID: chrome-extension (ejbfndjdeemmhccclagchbdbkinepoof)</div>
  <div class="summary-bar">
    <div>Total: <strong>${report.summary.total}</strong></div>
    <div>Unchanged: <strong style="color: var(--success)">${report.summary.unchanged}</strong></div>
    <div>Changed: <strong style="color: var(--accent)">${report.summary.changed}</strong></div>
  </div>
  ${report.screens.map(s => `
    <div class="card">
      <div class="card-header">
        <strong>${s.name}</strong>
        <span class="badge ${s.status === 'unchanged' ? 'badge-unchanged' : 'badge-changed'}">${s.status.toUpperCase()} (${s.diffPercentage} diff, ${s.diffPixels} px)</span>
      </div>
      <div class="grid-images">
        <div class="img-box">
          <h3>Baseline (Before)</h3>
          <img src="${s.baselineImage}" alt="Baseline">
        </div>
        <div class="img-box">
          <h3>Candidate (After)</h3>
          <img src="${s.candidateImage}" alt="Candidate">
        </div>
        <div class="img-box">
          <h3>Diff Highlight (Coral #fd8d68)</h3>
          <img src="${s.diffImage}" alt="Diff">
        </div>
      </div>
    </div>
  `).join('')}
</body>
</html>`

  writeFileSync('test-output/frameshift/report.html', html)
  console.log('Generated Frameshift visual report: test-output/frameshift/report.html')
}

async function main() {
  const mode = process.argv[2] || 'run'
  if (mode === 'baseline') {
    await captureCheckpoints('baseline')
  } else if (mode === 'candidate') {
    await captureCheckpoints('candidate')
  } else {
    // Full run: capture baseline, candidate, compare
    console.log('=== Step 1: Capturing Baseline Checkpoints ===')
    await captureCheckpoints('baseline')
    console.log('\n=== Step 2: Capturing Candidate Checkpoints ===')
    await captureCheckpoints('candidate')
    console.log('\n=== Step 3: Running Pixelmatch Diff & Frameshift Report ===')
    const results = compareSnapshots()
    generateFrameshiftReport(results)
    for (const r of results) {
      console.log(`  ${r.name.padEnd(25)}: ${r.status} (${r.diffPixels} diff px / ${(r.diffRatio * 100).toFixed(3)}%)`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

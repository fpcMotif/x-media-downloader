/**
 * Twitter/X Thread Replier Blocker (Async API Edition)
 *
 * Efficiently blocks repliers under a tweet/thread using X's internal
 * first-party endpoint (`/i/api/1.1/blocks/create.json`) instead of fragile
 * DOM UI clicking.
 *
 * Guarantees:
 *   1. Never blocks the Original Poster (OP), including self-replies and thread continuations.
 *   2. Never blocks the logged-in user account.
 *   3. Enforces humanized randomized pacing and batch cooldowns to respect platform rules.
 *   4. Operates asynchronously in the background with a floating on-screen HUD.
 *
 * Usage:
 *   Paste this script into the browser's DevTools Console (F12) while viewing
 *   any tweet permalink (x.com/<user>/status/<id>).
 */

const CONFIG = {
  MAX_BLOCKS_PER_SESSION: 15, // Hard cap per session to prevent rate-limit flags
  MIN_DELAY_MS: 3500,         // Minimum delay before each block action (3.5s)
  MAX_DELAY_MS: 7000,         // Maximum delay before each block action (7.0s)
  BATCH_SIZE: 4,              // Take a rest cooldown after every N blocks
  COOLDOWN_MIN_MS: 20000,     // Minimum cooldown rest (20s)
  COOLDOWN_MAX_MS: 30000,     // Maximum cooldown rest (30s)
  DRY_RUN: false,             // Set true to simulate without sending actual API calls
};

const BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cleanHandle(raw) {
  if (!raw) return '';
  return raw.trim().replace(/^@/, '').split(/[/?#]/)[0].toLowerCase();
}

function setStatus(txt) {
  const el = document.getElementById('sb-status');
  if (el) el.innerText = txt;
}

function setCount(n) {
  const el = document.getElementById('sb-count');
  if (el) el.innerText = `Blocked: ${n} / ${CONFIG.MAX_BLOCKS_PER_SESSION}`;
}

// ── 1. IDENTITY & AUTHOR EXTRACTION ──────────────────────────────────────────
function extractTweetAuthor(tweet) {
  const statusAnchor = Array.from(tweet.querySelectorAll('a[href*="/status/"]')).find(
    (a) => !a.closest('div[role="link"]') && a.querySelector('time') !== null
  );
  if (statusAnchor) {
    const m = /^\/([A-Za-z0-9_]+)\/status\/\d+/.exec(statusAnchor.getAttribute('href') ?? '');
    if (m?.[1]) return cleanHandle(m[1]);
  }
  const userBlock = tweet.querySelector('[data-testid="User-Name"]');
  const profileLink = userBlock?.querySelector('a[href^="/"]');
  const handle = profileLink?.getAttribute('href')?.slice(1)?.split('/')[0];
  return cleanHandle(handle);
}

function isOpTweet(tweet, opHandle) {
  if (!opHandle) return false;
  const op = cleanHandle(opHandle);

  const timeAnchors = Array.from(tweet.querySelectorAll('a[href*="/status/"]')).filter(
    (a) => !a.closest('div[role="link"]') && a.querySelector('time') !== null
  );
  for (const a of timeAnchors) {
    const m = /^\/([A-Za-z0-9_]+)\/status\/\d+/.exec(a.getAttribute('href') ?? '');
    if (m?.[1] && cleanHandle(m[1]) === op) return true;
  }
  return false;
}

// ── 2. DIRECT ASYNC API CALL ────────────────────────────────────────────────
async function apiBlockUser(screenName, csrfToken, whitelist) {
  if (whitelist.has(cleanHandle(screenName))) {
    return { ok: false, status: 'aborted_whitelisted' };
  }

  try {
    const res = await fetch('https://x.com/i/api/1.1/blocks/create.json', {
      method: 'POST',
      credentials: 'include',
      headers: {
        authorization: BEARER_TOKEN,
        'x-csrf-token': csrfToken,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `screen_name=${encodeURIComponent(screenName)}`,
    });

    if (res.ok) {
      return { ok: true, status: 'blocked' };
    }

    const errJson = await res.json().catch(() => ({}));
    const errMsg = errJson.errors?.[0]?.message || `HTTP ${res.status}`;

    // If user was already blocked previously, treat as satisfied
    if (res.status === 403 && errMsg.toLowerCase().includes('already blocked')) {
      return { ok: true, status: 'already_blocked' };
    }

    return { ok: false, status: errMsg };
  } catch (e) {
    return { ok: false, status: e.message };
  }
}

// ── 3. MAIN RUNNER ──────────────────────────────────────────────────────────
(async () => {
  // Read CSRF token from active browser session cookies
  const csrfMatch = document.cookie.match(/(?:^|;\s*)ct0=([a-f0-9]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : null;

  if (!csrfToken) {
    console.error('[Async Blocker] Failed to read ct0 CSRF cookie. Please make sure you are logged into x.com.');
    return;
  }

  // Resolve Original Poster (OP) from URL path or first tweet
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  let opHandle = pathParts[0]?.toLowerCase();
  if (opHandle === 'i' || !opHandle || pathParts[1] !== 'status') {
    const firstStatus = document.querySelector('article[data-testid="tweet"] a[href*="/status/"]');
    const m = /^\/([A-Za-z0-9_]+)\/status\/\d+/.exec(firstStatus?.getAttribute('href') ?? '');
    opHandle = m?.[1]?.toLowerCase();
  }

  if (!opHandle) {
    console.error('[Async Blocker] Could not detect original poster. Please run on a tweet permalink.');
    return;
  }

  // Resolve logged-in account to avoid self-blocking
  const selfHandle = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')
    ?.getAttribute('href')?.replace('/', '')?.toLowerCase();

  const whitelist = new Set([cleanHandle(opHandle), cleanHandle(selfHandle)].filter(Boolean));
  console.log(`[Async Blocker] OP: @${opHandle} | Whitelist:`, Array.from(whitelist));

  // ── FLOATING HUD ───────────────────────────────────────────────────────────
  window.stopSafetyBlocker = false;
  document.getElementById('x-safety-blocker-hud')?.remove();

  const hud = document.createElement('div');
  hud.id = 'x-safety-blocker-hud';
  Object.assign(hud.style, {
    position: 'fixed', top: '16px', right: '16px', zIndex: 999999,
    padding: '14px 18px', background: '#15202b', color: '#f7f9f9',
    border: '1px solid #38444d', borderRadius: '12px', fontSize: '13px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.6)', fontFamily: 'system-ui, -apple-system, sans-serif'
  });
  hud.innerHTML = `
    <div style="font-weight: 700; margin-bottom: 4px;">Async API Blocker</div>
    <div id="sb-status" style="color: #8899a6; font-size: 12px;">Initializing...</div>
    <div id="sb-count" style="margin: 6px 0; font-weight: 600;">Blocked: 0 / ${CONFIG.MAX_BLOCKS_PER_SESSION}</div>
    <button id="sb-stop" style="width: 100%; padding: 6px 12px; background: #e0245e; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 700;">Stop</button>
  `;
  document.body.appendChild(hud);

  hud.querySelector('#sb-stop')?.addEventListener('click', () => {
    window.stopSafetyBlocker = true;
    setStatus('Stopping...');
  });

  // ── ORCHESTRATION LOOP ─────────────────────────────────────────────────────
  let totalBlocked = 0;
  const processed = new Set(whitelist);

  try {
    while (!window.stopSafetyBlocker && totalBlocked < CONFIG.MAX_BLOCKS_PER_SESSION) {
      const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      let foundCandidateInView = false;

      for (const tweet of tweets) {
        if (window.stopSafetyBlocker || totalBlocked >= CONFIG.MAX_BLOCKS_PER_SESSION) break;

        // Never touch OP self-replies or thread continuations
        if (isOpTweet(tweet, opHandle)) continue;

        const author = extractTweetAuthor(tweet);
        if (!author || processed.has(author) || whitelist.has(author)) continue;
        processed.add(author);
        foundCandidateInView = true;

        if (CONFIG.DRY_RUN) {
          totalBlocked++;
          setCount(totalBlocked);
          console.log(`[DRY RUN] Would block: @${author}`);
          await sleep(500);
          continue;
        }

        // Pacing delay before API call to maintain human timing
        const preDelay = rand(CONFIG.MIN_DELAY_MS, CONFIG.MAX_DELAY_MS);
        setStatus(`Pacing ${(preDelay / 1000).toFixed(1)}s before @${author}...`);
        await sleep(preDelay);

        if (window.stopSafetyBlocker) break;

        // Execute single background network call
        setStatus(`API blocking @${author}...`);
        const result = await apiBlockUser(author, csrfToken, whitelist);

        if (result.ok) {
          totalBlocked++;
          setCount(totalBlocked);
          console.log(`[Blocked ${totalBlocked}/${CONFIG.MAX_BLOCKS_PER_SESSION}] @${author} (${result.status})`);

          // Scheduled cooldown rest every BATCH_SIZE actions
          if (totalBlocked % CONFIG.BATCH_SIZE === 0 && totalBlocked < CONFIG.MAX_BLOCKS_PER_SESSION) {
            const cooldown = rand(CONFIG.COOLDOWN_MIN_MS, CONFIG.COOLDOWN_MAX_MS);
            let sec = Math.round(cooldown / 1000);
            console.log(`[Schedule] Taking a ${sec}s cooldown rest...`);
            while (sec > 0 && !window.stopSafetyBlocker) {
              setStatus(`Cooldown rest: ${sec}s...`);
              await sleep(1000);
              sec--;
            }
          }
        } else {
          console.warn(`[Async Blocker] Could not block @${author}: ${result.status}`);
        }
      }

      if (window.stopSafetyBlocker || totalBlocked >= CONFIG.MAX_BLOCKS_PER_SESSION) break;

      // Scroll to hydrate virtualized feed (instant scroll works reliably in background tabs)
      setStatus('Scanning for more replies...');
      const prevY = window.scrollY;
      window.scrollBy(0, rand(700, 950));
      window.dispatchEvent(new Event('scroll'));

      // Wait for network & virtualizer hydration
      await sleep(rand(2500, 4000));

      // In background tabs, retry 3 times before concluding end of thread
      if (window.scrollY === prevY && !foundCandidateInView) {
        let retries = 3;
        let recovered = false;
        while (retries > 0 && !window.stopSafetyBlocker) {
          retries--;
          setStatus(`Verifying end of thread (retry ${3 - retries}/3)...`);
          window.scrollBy(0, 1000);
          window.dispatchEvent(new Event('scroll'));
          await sleep(2500);
          const freshTweets = document.querySelectorAll('article[data-testid="tweet"]');
          if (freshTweets.length > tweets.length || window.scrollY !== prevY) {
            recovered = true;
            break;
          }
        }
        if (!recovered) {
          console.log('[Async Blocker] Reached end of replies.');
          break;
        }
      }
    }
  } finally {
    const finalMsg = totalBlocked >= CONFIG.MAX_BLOCKS_PER_SESSION
      ? `Completed session budget (${CONFIG.MAX_BLOCKS_PER_SESSION} blocked).`
      : `Halted (${totalBlocked} blocked).`;
    setStatus(finalMsg);
    console.log(`[Async Blocker] Finished. Total accounts blocked: ${totalBlocked}`);
    setTimeout(() => hud.remove(), 5000);
  }
})();

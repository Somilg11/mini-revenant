/**
 * Records the §13 demo as a video by driving a real browser through the app.
 *
 *   bun scripts/demo-video.ts
 *
 * Expects the API on :8090 and the web app on :3000, a replayed database, and
 * `scripts/demo-narration.json` beside a `durations.json` produced by `say`
 * (see the README's "Demo video" section). Each narration section is held on
 * screen for at least its audio length; the actual start time of every section
 * is written to `timeline.json`, which the muxing step uses to place the
 * audio, so voice and picture stay aligned however long a click took.
 */
import { chromium, type Page } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const WEB = process.env.DEMO_WEB ?? 'http://localhost:3000';
const API = process.env.DEMO_API ?? 'http://localhost:8090';
const OUT = process.env.DEMO_OUT ?? '.';
const T = JSON.parse(readFileSync(process.env.DEMO_TARGETS ?? 'scripts/demo-targets.json', 'utf8')) as {
  incident: string;
  recoveredCase: string;
  recoveredPayment: string;
  /** A still-failed international 3DS case, untouched, for the five-options beat. */
  showcaseCase: string;
  approveCase: string;
  faultCase: string;
  denyCase: string;
  denyMerchant: string;
};
const narration = JSON.parse(readFileSync('scripts/demo-narration.json', 'utf8')) as { id: string; text: string }[];
const durations = JSON.parse(readFileSync(`${OUT}/durations.json`, 'utf8')) as { id: string; seconds: number }[];
const secondsFor = (id: string) => durations.find((d) => d.id === id)?.seconds ?? 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A caption bar that survives navigation: recreated by an init script on every load. */
const CAPTION_INIT = `
  (function () {
    function mount() {
      if (document.getElementById('__demo_caption')) return;
      var el = document.createElement('div');
      el.id = '__demo_caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1180px;width:calc(100% - 80px);background:rgba(10,11,14,0.86);color:#fff;font:15px/1.5 -apple-system,Inter,system-ui,sans-serif;padding:12px 18px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);z-index:99999;pointer-events:none;box-shadow:0 8px 32px rgba(0,0,0,0.45);opacity:0;transition:opacity 180ms ease';
      el.textContent = window.__demoCaption || '';
      if (window.__demoCaption) el.style.opacity = '1';
      (document.body || document.documentElement).appendChild(el);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
    window.__setDemoCaption = function (t) { window.__demoCaption = t; mount(); var el = document.getElementById('__demo_caption'); if (el) { el.textContent = t; el.style.opacity = t ? '1' : '0'; } };
  })();
`;

async function caption(page: Page, text: string) {
  await page.evaluate((t) => (window as unknown as { __setDemoCaption: (s: string) => void }).__setDemoCaption(t), text).catch(() => {});
}

async function smoothScroll(page: Page, to: number, ms = 900) {
  await page.evaluate(
    ({ to, ms }) =>
      new Promise<void>((resolve) => {
        const from = window.scrollY;
        const start = performance.now();
        const step = (now: number) => {
          const k = Math.min(1, (now - start) / ms);
          const e = k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k;
          window.scrollTo(0, from + (to - from) * e);
          if (k < 1) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      }),
    { to, ms },
  );
}

async function scrollToText(page: Page, text: string, offset = 120) {
  const y = await page.evaluate(
    ({ text, offset }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if (n.textContent && n.textContent.includes(text)) {
          const r = (n.parentElement as HTMLElement).getBoundingClientRect();
          return Math.max(0, window.scrollY + r.top - offset);
        }
      }
      return null;
    },
    { text, offset },
  );
  if (y !== null) await smoothScroll(page, y);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    recordVideo: { dir: `${OUT}/video`, size: { width: 1600, height: 1000 } },
    colorScheme: 'dark',
  });
  await context.addInitScript(CAPTION_INIT);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  const timeline: { id: string; startedAt: number; endedAt: number }[] = [];
  const t0 = Date.now();
  let current: { id: string; startedAt: number } | null = null;

  /** Starts a narration section: sets the caption and remembers when it began. */
  const begin = async (id: string) => {
    if (current) timeline.push({ ...current, endedAt: Date.now() - t0 });
    current = { id, startedAt: Date.now() - t0 };
    const text = narration.find((n) => n.id === id)?.text ?? '';
    await caption(page, text);
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${id}`);
  };
  /** Holds until the section's narration has had time to finish. */
  const hold = async (extraMs = 600) => {
    if (!current) return;
    const due = current.startedAt + secondsFor(current.id) * 1000 + extraMs;
    const wait = due - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  };

  const goto = async (path: string) => {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
    await sleep(400);
    if (current) await caption(page, narration.find((n) => n.id === current!.id)?.text ?? '');
  };

  // 0–1 open on the Command Center
  await goto('/');
  await begin('00-open');
  await hold();
  await begin('01-what');
  await hold();

  // 2 the tiles
  await begin('02-command');
  await hold();

  // 3 the strip, then Play for a bit, then Pause
  await begin('03-strip');
  await scrollToText(page, 'Acceptance', 160).catch(() => {});
  await sleep(2500);
  await smoothScroll(page, 0);
  const play = page.getByRole('button', { name: /Play/ });
  if (await play.count()) {
    await play.first().click();
    await sleep(9000);
    const pause = page.getByRole('button', { name: /Pause/ });
    if (await pause.count()) await pause.first().click();
  }
  await hold();

  // 4 incidents
  await begin('04-detect');
  await goto('/incidents');
  await sleep(2500);
  await goto(`/incidents/${T.incident}`);
  await hold();

  // 5 scoreboard
  await begin('05-scoreboard');
  await goto('/simulator');
  await sleep(1500);
  await scrollToText(page, 'The five injected incidents', 140).catch(() => {});
  await hold();

  // 6 root cause
  await begin('06-rca');
  await goto(`/incidents/${T.incident}`);
  await scrollToText(page, 'Ranked by', 160).catch(() => {});
  await hold();

  // 7 narrative
  await begin('07-narrative');
  await scrollToText(page, 'Narrative', 140).catch(() => {});
  await hold();

  // 8 a case
  await begin('08-case');
  await goto(`/recovery/${T.showcaseCase}`);
  await sleep(1500);
  await scrollToText(page, 'Expected value', 200).catch(() => {});
  await sleep(3000);
  await scrollToText(page, 'do_nothing', 300).catch(() => {});
  await hold();

  // 9 policy page
  await begin('09-policy');
  await goto('/policy');
  await sleep(2000);
  await scrollToText(page, 'The guardrail is a compile error', 120).catch(() => {});
  await hold();

  // 10 DENY: pause the merchant, approve → DENY
  await begin('10-deny');
  await fetch(`${API}/api/v1/merchants/${T.denyMerchant}/pause`, { method: 'POST' });
  await goto(`/recovery/${T.denyCase}`);
  const approveDeny = page.getByRole('button', { name: 'Approve' });
  if (await approveDeny.count()) {
    await approveDeny.first().click();
    await sleep(2500);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await caption(page, narration.find((n) => n.id === '10-deny')!.text);
  await scrollToText(page, 'Policy gate', 120).catch(() => {});
  await hold();
  await fetch(`${API}/api/v1/merchants/${T.denyMerchant}/resume`, { method: 'POST' });

  // 11 approve live
  await begin('11-approve');
  await goto(`/recovery/${T.approveCase}`);
  const approve = page.getByRole('button', { name: 'Approve' });
  if (await approve.count()) {
    await sleep(1200);
    await approve.first().click();
    await sleep(3500);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await caption(page, narration.find((n) => n.id === '11-approve')!.text);
  await scrollToText(page, 'idempotency key', 200).catch(() => {});
  await hold();

  // 12 inject faults, approve another
  await begin('12-fault');
  await goto('/simulator');
  await scrollToText(page, 'inject a fault', 200).catch(() => {});
  const inject = page.getByRole('button', { name: /429/ });
  if (await inject.count()) {
    await inject.first().click();
    await sleep(1500);
  }
  await goto(`/recovery/${T.faultCase}`);
  const approve2 = page.getByRole('button', { name: 'Approve' });
  if (await approve2.count()) {
    await sleep(800);
    await approve2.first().click();
    await sleep(5000);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await caption(page, narration.find((n) => n.id === '12-fault')!.text);
  await scrollToText(page, 'attempts', 220).catch(() => {});
  await hold();

  // 13 verify + live calibration
  await begin('13-verify');
  await goto(`/recovery/${T.recoveredCase}`);
  await scrollToText(page, 'Verified outcome', 120).catch(() => {});
  await sleep(6000);
  await goto('/model');
  await scrollToText(page, 'Calibration — live', 100).catch(() => {});
  await hold();

  // 14 audit
  await begin('14-audit');
  await goto(`/audit/${T.recoveredPayment}`);
  await sleep(2500);
  await scrollToText(page, 'POLICY', 200).catch(() => {});
  await sleep(3000);
  await scrollToText(page, 'OUTCOME', 260).catch(() => {});
  await hold();

  // 15–17 what-if
  await begin('15-whatif');
  await goto('/whatif');
  await hold();
  await begin('16-founder');
  await scrollToText(page, 'International only', 160).catch(() => {});
  await hold();
  await begin('17-close');
  await smoothScroll(page, 0);
  await hold(1500);
  await caption(page, '');
  await sleep(1200);

  if (current) timeline.push({ ...current, endedAt: Date.now() - t0 });
  await context.close();
  await browser.close();
  writeFileSync(`${OUT}/timeline.json`, JSON.stringify(timeline, null, 1));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s; timeline written`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

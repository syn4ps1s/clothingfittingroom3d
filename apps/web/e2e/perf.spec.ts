import { test } from '@playwright/test';

test('timings', async ({ page }) => {
  const t0 = Date.now();
  const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
  page.on('console', (m) => {
    if (m.text().startsWith('[t]')) log(m.text());
  });
  await page.addInitScript(() => {
    const t = performance.now.bind(performance);
    (window as unknown as { __t: () => number }).__t = t;
  });
  await page.goto(process.env.SMOKE_URL ?? '/?mock=1&quality=low&lang=es');
  log('goto done');
  await page.waitForSelector('h1');
  log('h1');
  await page.waitForSelector('[data-placed="true"]', { timeout: 120000 });
  log('placed');
  const n = await page.evaluate(() => performance.getEntriesByType('resource').length);
  log(`resources ${n}`);
});

import { test } from '@playwright/test';

const url = process.env.SMOKE_URL ?? '/?mock=1&quality=medium&lang=es';

test('captura de bienvenida (smoke)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForSelector('[data-placed="true"]', { timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: '../../.scratch/world/smoke-welcome.png' });
  console.log(errors.join('\n'));
});

import { test, expect } from '@playwright/test';

function silenceWav() {
  const buffer = Buffer.alloc(44 + 4800);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(4800, 40);
  return buffer.toString('base64');
}

async function ready(page) {
  await page.route('**/api/companion/status', (route) => route.fulfill({ json: { ready: true } }));
  await page.goto('/');
  await expect(page.locator('#companion-state')).toHaveText('Ready · local only');
}

test('typed conversation returns a spoken reply and bounded history', async ({ page }) => {
  let payload;
  await page.route('**/api/companion/chat', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({ json: { transcript: payload.text, text: 'Hello! I am Pip.', action: 'none', audio: silenceWav() } });
  });
  await ready(page);
  await page.getByLabel('Or type a message').fill('Hello Pip');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#companion-reply')).toHaveText('Hello! I am Pip.');
  await expect(page.locator('#companion-state')).toHaveText('Ready · local only');
  expect(payload.history).toEqual([]);
  expect(payload.context.glassAvailable).toBe(false);
  await expect(page.locator('#companion-error')).toBeHidden();
});

test('an explicit microphone turn sends audio and releases the microphone', async ({ page }) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.testMicrophone = await getUserMedia(constraints);
      return window.testMicrophone;
    };
  });
  let audio;
  await page.route('**/api/companion/talk', async (route) => {
    audio = route.request().postDataJSON().audio;
    await route.fulfill({ json: { transcript: 'Hello Pip', text: 'Hello there.', action: 'none', audio: silenceWav() } });
  });
  await ready(page);
  await page.getByRole('button', { name: 'Talk to Pip' }).click();
  await expect(page.locator('#companion-state')).toHaveText('Listening · tap again to send');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Finish & send' }).click();
  await expect(page.locator('#companion-reply')).toHaveText('Hello there.');
  expect(Buffer.from(audio, 'base64').length).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.testMicrophone.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
});

test('microphone permission denial is visible and retryable', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
  });
  await ready(page);
  await page.getByRole('button', { name: 'Talk to Pip' }).click();
  await expect(page.locator('#companion-error')).toContainText('Allow microphone access');
  await expect(page.getByRole('button', { name: 'Talk to Pip' })).toBeEnabled();
});

test('cancelling while microphone permission is pending stops a late stream', async ({ page }) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.testMicrophone = await getUserMedia(constraints);
      return new Promise((resolve) => { window.resolveTestMicrophone = () => resolve(window.testMicrophone); });
    };
  });
  await ready(page);
  await page.getByRole('button', { name: 'Talk to Pip' }).click();
  await expect.poll(() => page.evaluate(() => typeof window.resolveTestMicrophone)).toBe('function');
  await page.getByRole('button', { name: 'Cancel / stop' }).click();
  await page.evaluate(() => window.resolveTestMicrophone());
  await expect.poll(() => page.evaluate(() => window.testMicrophone.getTracks().every((track) => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#companion-state')).toHaveText('Ready · local only');
});

test('a companion throw command cannot move an unplaced glass', async ({ page }) => {
  await page.route('**/api/companion/chat', (route) => route.fulfill({
    json: { transcript: 'Throw the glass', text: 'I will throw its virtual copy.', action: 'throw_glass', audio: silenceWav() },
  }));
  await ready(page);
  await page.getByLabel('Or type a message').fill('Throw the glass');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#companion-error')).toContainText('Place the virtual glass');
});

test('a companion can pick up and throw a placed virtual glass', async ({ page }) => {
  let context;
  await page.route('**/api/companion/chat', async (route) => {
    context = route.request().postDataJSON().context;
    await route.fulfill({
      json: { transcript: 'Pick up the glass and throw it', text: 'I will throw the virtual cup.', action: 'throw_glass', audio: silenceWav() },
    });
  });
  await ready(page);
  await page.getByRole('button', { name: 'Try desktop demo' }).click();
  const canvas = page.locator('#viewport canvas');
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.65 } });
  await page.getByLabel('Or type a message').fill('Pick up the glass and throw it');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Virtual cup thrown.', { timeout: 10_000 });
  expect(context.glassAvailable).toBe(true);
  await expect(page.locator('#companion-error')).toBeHidden();
});

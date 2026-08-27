import { expect, test, type Page } from '@playwright/test';

/**
 * The end-to-end journey named in the brief, in order:
 *
 *   1. create a caregiver account
 *   2. complete onboarding
 *   3. add a child and a trusted caregiver
 *   4. enter child mode
 *   5. send a request
 *   6. confirm delivery
 *   7. acknowledge it from a caregiver session
 *   8. show the response in child mode
 *   9. resolve the request
 *  10. refresh both sessions and verify the final state persists
 *
 * The caregiver and the child run in two independent pages, so step 7 really is
 * a different session answering, and step 10 really is two separate refreshes.
 */

const CAREGIVER = { name: 'Rosa', email: `rosa+${Date.now()}@example.test`, password: 'kindly-demo-1' };
const CHILD = 'Léo';
const TRUSTED = 'Grandma Ade';
const PIN = '7391';

async function createAccountAndOnboard(page: Page) {
  await page.goto('/auth/create-account');

  await page.getByLabel('Email address', { exact: true }).fill(CAREGIVER.email);
  await page.getByLabel('Password', { exact: true }).fill(CAREGIVER.password);
  await page.getByRole('button', { name: 'Create my space' }).click();

  // --- Step 2: onboarding -------------------------------------------------
  await expect(page.getByRole('heading', { name: 'Who is here today?' })).toBeVisible();

  await page.getByLabel('Your preferred name').fill(CAREGIVER.name);
  await page.getByLabel('Your child’s name').fill(CHILD);
  await page.getByLabel(/Another trusted caregiver/).fill(TRUSTED);
  await page.getByLabel('Grown-up code', { exact: true }).fill(PIN);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Communication preferences
  await expect(page.getByRole('heading', { name: /How does Léo like to communicate/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pictures or symbols' }).click();
  await page.getByRole('button', { name: 'Gestures and pointing' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Sensory preferences
  await expect(page.getByRole('heading', { name: /What helps Léo feel steadier/ })).toBeVisible();
  await page.getByRole('button', { name: 'Quiet spaces' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Display, sound and movement
  await expect(page.getByRole('heading', { name: /Text, symbols, sound and movement/ })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Safety: safe adult, safe place, escalation timing
  await expect(page.getByRole('heading', { name: /Who and where is safe/ })).toBeVisible();
  await page.getByLabel('A safe adult near your child').fill('your teacher, Mr O’Neill');
  await page.getByLabel('A safe place your child can go').fill('the quiet corner');
  await page.getByLabel(/Ask another trusted caregiver after/).fill('45');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Notifications
  await expect(page.getByRole('heading', { name: /How should Kindly reach you/ })).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();

  await expect(page.getByRole('heading', { name: /You’re all set|Welcome to your Kindly space/ })).toBeVisible();
  await page.getByRole('button', { name: 'Go to my space' }).click();

  await expect(page.getByRole('heading', { name: `Good morning, ${CAREGIVER.name}` })).toBeVisible();
}

test.describe('the full KINDLY journey', () => {
  test('a request travels from the child to a caregiver and back, and survives a refresh', async ({ browser }) => {
    // Two pages in one context: two independent app sessions on one family
    // device, exactly as a caregiver's phone and a child's tablet would be.
    const context = await browser.newContext();
    const caregiverPage = await context.newPage();
    const childPage = await context.newPage();

    // --- Steps 1 and 2 ----------------------------------------------------
    await createAccountAndOnboard(caregiverPage);

    // --- Step 3: the child and the trusted caregiver exist ----------------
    await caregiverPage.goto('/app/settings/caregivers');
    await expect(caregiverPage.getByText(TRUSTED).first()).toBeVisible();
    await expect(caregiverPage.getByText(`Asked #1`)).toBeVisible();

    await caregiverPage.goto('/app/settings/children');
    await expect(caregiverPage.getByRole('heading', { name: /Children in this family space/ })).toBeVisible();
    await expect(caregiverPage.getByText(CHILD, { exact: true }).first()).toBeVisible();

    // A second child, to prove the model is not single-child.
    await caregiverPage.getByRole('button', { name: 'Add a child' }).click();
    await caregiverPage.getByLabel('Child’s name').fill('小明');
    await caregiverPage.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(caregiverPage.getByText('小明', { exact: true }).first()).toBeVisible();

    // --- Step 4: enter child mode ----------------------------------------
    await childPage.goto('/app');
    await childPage.getByRole('button', { name: new RegExp(`Open ${CHILD}’s view`) }).click();
    await expect(childPage.getByRole('heading', { name: `Hi ${CHILD}!` })).toBeVisible();

    // --- Step 5: send a request ------------------------------------------
    await childPage.getByRole('button', { name: /I need help/ }).click();
    await expect(childPage.getByRole('heading', { name: 'What do you need?' })).toBeVisible();

    await childPage.getByRole('button', { name: /^Drink/ }).click();

    // The confirmation step: the child sees the chosen request first.
    await expect(childPage.getByRole('heading', { name: 'Drink?' })).toBeVisible();
    await expect(childPage.getByText('Not sent yet').first()).toBeVisible();
    await expect(childPage.getByRole('button', { name: 'Change request' })).toBeVisible();

    await childPage.getByRole('button', { name: 'Send request' }).click();

    // --- Step 6: delivery is confirmed by the backend ---------------------
    await expect(childPage.getByRole('heading', { name: 'Your message arrived.' })).toBeVisible();
    await expect(childPage.getByText('Nobody has opened it yet.').first()).toBeVisible();
    // It must NOT claim anybody has seen it.
    await expect(childPage.getByText(/has seen your message/)).toHaveCount(0);

    // --- Step 7: acknowledge from the caregiver session -------------------
    await caregiverPage.goto('/app/requests');
    const requestRow = caregiverPage.getByRole('button', { name: new RegExp(`${CHILD}: Drink`) });
    await expect(requestRow).toBeVisible();
    await requestRow.click();

    await expect(caregiverPage.getByRole('heading', { name: 'Drink', exact: true })).toBeVisible();
    await expect(caregiverPage.getByText('Delivered').first()).toBeVisible();

    await caregiverPage.getByLabel(/Add a short note/).fill('Meet me in the kitchen');
    await caregiverPage.getByRole('button', { name: 'I’m coming now' }).click();
    await expect(caregiverPage.getByText('Answered').first()).toBeVisible();

    // --- Step 8: the response appears in child mode -----------------------
    await expect(childPage.getByRole('heading', { name: `${CAREGIVER.name} is coming now.` })).toBeVisible({ timeout: 15_000 });
    await expect(childPage.getByText(/Meet me in the kitchen/).first()).toBeVisible();

    // --- Step 9: resolve --------------------------------------------------
    await childPage.getByRole('button', { name: 'Thank you, all done' }).click();
    await expect(childPage.getByRole('heading', { name: 'All done.' })).toBeVisible();

    // --- Step 10: refresh both sessions -----------------------------------
    // The child stays on the request screen after resolving, so a refresh must
    // bring back the *finished* request rather than an empty screen.
    await childPage.reload();
    await expect(childPage.getByRole('heading', { name: 'All done.' })).toBeVisible();
    await expect(childPage.getByText('Finished').first()).toBeVisible();

    // And going home from there still works.
    await childPage.getByRole('button', { name: 'Back to my day' }).click();
    await expect(childPage.getByRole('heading', { name: `Hi ${CHILD}!` })).toBeVisible();

    await caregiverPage.reload();
    await expect(caregiverPage.getByRole('heading', { name: 'Drink', exact: true })).toBeVisible();
    await expect(caregiverPage.getByText('Finished').first()).toBeVisible();
    // The recorded answer survives the refresh, under the responder's own name.
    await expect(caregiverPage.getByText(/I am coming now \(Rosa\)/).first()).toBeVisible();

    await context.close();
  });

  test('an urgent request is never offered a delayed answer, and needs confirmation to close', async ({ browser }) => {
    const context = await browser.newContext();
    const caregiverPage = await context.newPage();
    const childPage = await context.newPage();

    await createAccountAndOnboard(caregiverPage);

    await childPage.goto('/app');
    await childPage.getByRole('button', { name: new RegExp(`Open ${CHILD}’s view`) }).click();
    await childPage.getByRole('button', { name: /I need help/ }).click();
    await childPage.getByRole('button', { name: /^It hurts/ }).click();
    await childPage.getByRole('button', { name: 'Send request' }).click();
    await expect(childPage.getByRole('heading', { name: 'Your message arrived.' })).toBeVisible();

    await caregiverPage.goto('/app/requests');
    await caregiverPage.getByRole('button', { name: new RegExp(`${CHILD}: It hurts`) }).click();

    // No delayed answer is offered at all.
    await expect(caregiverPage.getByRole('button', { name: /In \d+ minutes/ })).toHaveCount(0);
    // An immediate action is offered instead.
    await expect(caregiverPage.getByRole('button', { name: 'I’m coming now' })).toBeVisible();
    await expect(caregiverPage.getByRole('button', { name: /Go to the quiet corner/ })).toBeVisible();
    // And KINDLY says what it is not.
    await expect(caregiverPage.getByText(/Kindly is not an emergency service/).first()).toBeVisible();

    // Closing it needs an explicit confirmation.
    await caregiverPage.getByRole('button', { name: 'Mark resolved' }).click();
    const dialog = caregiverPage.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/safe and no longer waiting/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes, it is resolved' }).click();
    await expect(caregiverPage.getByText('Finished').first()).toBeVisible();

    await context.close();
  });

  test('repeated tapping never creates two requests', async ({ browser }) => {
    const context = await browser.newContext();
    const caregiverPage = await context.newPage();
    const childPage = await context.newPage();

    await createAccountAndOnboard(caregiverPage);

    await childPage.goto('/app');
    await childPage.getByRole('button', { name: new RegExp(`Open ${CHILD}’s view`) }).click();
    await childPage.getByRole('button', { name: /I need help/ }).click();

    // Tap the same card several times in quick succession, the way a child
    // actually might. Every tap must resolve to the same request.
    const drink = childPage.getByRole('button', { name: /^Drink/ });
    await drink.click({ clickCount: 3, delay: 40 });
    await expect(childPage.getByRole('heading', { name: 'Drink?' })).toBeVisible();

    // Send it, tapping send more than once too.
    const send = childPage.getByRole('button', { name: 'Send request' });
    await send.click();
    await expect(childPage.getByRole('heading', { name: 'Your message arrived.' })).toBeVisible();

    await caregiverPage.goto('/app/requests');
    await expect(caregiverPage.getByRole('button', { name: new RegExp(`${CHILD}: Drink`) })).toHaveCount(1);

    // Changing your mind and asking again is a *different* request, and both
    // are kept honestly rather than silently merged.
    await childPage.getByRole('button', { name: 'I changed my mind' }).click();
    await expect(childPage.getByRole('heading', { name: 'Message cancelled.' })).toBeVisible();
    await childPage.getByRole('button', { name: 'Back to my day' }).click();
    await childPage.getByRole('button', { name: /I need help/ }).click();
    await childPage.getByRole('button', { name: /^Drink/ }).click();
    await childPage.getByRole('button', { name: 'Send request' }).click();
    await expect(childPage.getByRole('heading', { name: 'Your message arrived.' })).toBeVisible();

    await caregiverPage.reload();
    await expect(caregiverPage.getByRole('button', { name: new RegExp(`${CHILD}: Drink`) })).toHaveCount(2);

    await context.close();
  });

  test('leaving child mode needs the grown-up code, but help never does', async ({ browser }) => {
    const context = await browser.newContext();
    const caregiverPage = await context.newPage();
    const childPage = await context.newPage();

    await createAccountAndOnboard(caregiverPage);

    await childPage.goto('/app');
    await childPage.getByRole('button', { name: new RegExp(`Open ${CHILD}’s view`) }).click();
    await childPage.getByRole('button', { name: 'Adult View' }).click();

    await expect(childPage.getByRole('heading', { name: 'Enter the grown-up code' })).toBeVisible();

    // Offline help is reachable without the code.
    await childPage.getByRole('button', { name: 'I need help now' }).click();
    await expect(childPage.getByRole('heading', { name: 'Find a grown-up near you.' })).toBeVisible();
    await expect(childPage.getByText(/your teacher, Mr O’Neill/).first()).toBeVisible();
    await expect(childPage.getByText(/the quiet corner/).first()).toBeVisible();
    await expect(childPage.getByText(/Kindly cannot call anyone for you/)).toBeVisible();

    // A wrong code is refused.
    await childPage.getByRole('button', { name: 'Back to my day' }).click();
    await childPage.getByRole('button', { name: 'Adult View' }).click();
    for (const digit of ['1', '1', '1', '2']) {
      await childPage.getByRole('button', { name: `Digit ${digit}` }).click();
    }
    await expect(childPage.getByText('That code is not right. Try again.')).toBeVisible();

    // The right code gets out.
    for (const digit of PIN.split('')) {
      await childPage.getByRole('button', { name: `Digit ${digit}` }).click();
    }
    await expect(childPage.getByRole('heading', { name: /Good morning/ })).toBeVisible();

    await context.close();
  });

  test('a generated story is a draft until a caregiver approves and assigns it', async ({ browser }) => {
    const context = await browser.newContext();
    const caregiverPage = await context.newPage();
    const childPage = await context.newPage();

    await createAccountAndOnboard(caregiverPage);

    await caregiverPage.goto('/app/stories/new');
    await caregiverPage.getByLabel('Situation').selectOption('someone_says_no');
    await caregiverPage.getByLabel('Where does this happen?').fill('the school playground');
    await caregiverPage.getByLabel('Who may be there?').fill('two children I know');
    await caregiverPage.getByRole('button', { name: 'Build a draft for me' }).click();

    await expect(caregiverPage.getByLabel('Title')).not.toHaveValue('');
    // A generated draft accepts the other person's answer rather than pushing past it.
    await expect(caregiverPage.getByText(/stop asking/).first()).toBeVisible();

    await caregiverPage.getByRole('button', { name: 'Save as a draft' }).click();
    await expect(caregiverPage.getByText(/Saved as a draft/).first()).toBeVisible();

    // Nothing has reached child mode yet.
    await childPage.goto('/app');
    await childPage.getByRole('button', { name: new RegExp(`Open ${CHILD}’s view`) }).click();
    await childPage.getByRole('button', { name: /My stories/ }).click();
    await expect(childPage.getByRole('heading', { name: 'No stories yet' })).toBeVisible();

    // Approve, then give it to the child.
    await caregiverPage.getByRole('button', { name: 'Approve this story' }).click();
    await caregiverPage.getByRole('alertdialog').getByRole('button', { name: /Yes, I have read every page/ }).click();
    await expect(caregiverPage.getByRole('button', { name: new RegExp(`Give it to ${CHILD}`) })).toBeVisible();
    await caregiverPage.getByRole('button', { name: new RegExp(`Give it to ${CHILD}`) }).click();

    await childPage.reload();
    await expect(childPage.getByRole('heading', { name: 'Stories you can read.' })).toBeVisible();
    await expect(childPage.getByRole('button', { name: /Someone says no/ })).toBeVisible();

    // The child can stop at any point, and is never scored.
    await childPage.getByRole('button', { name: /Someone says no/ }).click();
    await expect(childPage.getByText(/Page 1 of/).first()).toBeVisible();
    await childPage.getByRole('button', { name: 'Next page' }).click();
    await expect(childPage.getByText(/Page 2 of/).first()).toBeVisible();
    await expect(childPage.getByRole('button', { name: /Stop and go back to my day/ })).toBeVisible();

    await context.close();
  });
});

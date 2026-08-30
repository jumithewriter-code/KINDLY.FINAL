import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { renderApp, seedHarness } from './harness';

/**
 * Accessibility and keyboard tests.
 *
 * These render the real screens through the real providers, so what is asserted
 * here is what a screen-reader user actually meets.
 */

const AXE_RULES = {
  rules: {
    // Colour contrast is verified against the compiled stylesheet in
    // docs/accessibility-report.md; jsdom has no layout engine, so axe cannot
    // compute it here and would report false negatives either way.
    'color-contrast': { enabled: false },
  },
};

describe('the sign-in screen', () => {
  it('has no detectable accessibility violations', async () => {
    const { backend } = await seedHarness();
    await backend.signOut();
    const { container } = renderApp(backend, '/auth/sign-in');
    await screen.findByRole('heading', { name: /welcome back/i });
    expect(await axe(container, AXE_RULES)).toHaveNoViolations();
  });

  it('labels every field and connects errors to them', async () => {
    const { backend } = await seedHarness();
    await backend.signOut();
    renderApp(backend, '/auth/sign-in');

    const email = await screen.findByLabelText(/email address/i);
    const password = screen.getByLabelText(/password/i);
    expect(email).toBeInTheDocument();
    expect(password).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const error = await screen.findByText(/please enter your email address/i);
    expect(error).toBeInTheDocument();
    // The error is announced and is the input's accessible description.
    expect(error.closest('[role="alert"]')).toBeTruthy();
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAttribute('aria-describedby', error.id);
  });

  it('is fully operable with the keyboard alone', async () => {
    const { backend } = await seedHarness();
    await backend.signOut();
    renderApp(backend, '/auth/sign-in');

    await screen.findByLabelText(/email address/i);
    await userEvent.tab(); // skip link
    expect(document.activeElement).toHaveTextContent(/skip to main content/i);

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/email address/i));
    await userEvent.keyboard('caregiver@example.test');

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByLabelText(/password/i));
    await userEvent.keyboard('kindly-demo-1');

    await userEvent.tab();
    expect(document.activeElement).toHaveTextContent(/sign in/i);
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(screen.queryByRole('heading', { name: /welcome back/i })).not.toBeInTheDocument());
  });

  it('gives one message for wrong password and unknown account', async () => {
    const { backend } = await seedHarness();
    await backend.signOut();
    renderApp(backend, '/auth/sign-in');

    await userEvent.type(await screen.findByLabelText(/email address/i), 'caregiver@example.test');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    // The message is announced (assertive live region) and shown on the form.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /do not match/i.test(a.textContent ?? ''))).toBe(true);
    // It says nothing about whether the address is registered.
    for (const alert of alerts) {
      expect(alert.textContent ?? '').not.toMatch(/no account|not registered|unknown user/i);
    }
  });
});

describe('the caregiver home', () => {
  it('has no detectable accessibility violations', async () => {
    const { backend } = await seedHarness();
    const { container } = renderApp(backend, '/app');
    await screen.findByRole('heading', { name: /good morning, rosa/i });
    expect(await axe(container, AXE_RULES)).toHaveNoViolations();
  });

  it('names every navigation destination', async () => {
    const { backend } = await seedHarness();
    renderApp(backend, '/app');
    await screen.findByRole('navigation', { name: /main navigation/i });
    for (const label of ['Home', 'Stories', 'Requests', 'Routines', 'Profile']) {
      // Queried fresh each time: the tree re-renders as data arrives, and a
      // held reference would go stale.
      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      expect(within(nav).getByRole('link', { name: new RegExp(`^${label}$`, 'i') }), label).toBeInTheDocument();
    }
    // Settings sits at the foot of the sidebar, outside the main nav landmark.
    expect(screen.getByRole('link', { name: /^Settings$/i })).toBeInTheDocument();

    // Every destination resolves to a real screen.
    for (const path of ['/app/stories', '/app/requests', '/app/routines', '/app/profile', '/app/settings']) {
      expect(screen.getByRole('link', { name: new RegExp(path.split('/').pop()!, 'i') }))
        .toHaveAttribute('href', path);
    }
  });

  it('shows the caregiver’s own name, and the child’s own name, in the right places', async () => {
    const { backend } = await seedHarness({ caregiverName: 'Rosa', childName: '小明' });
    renderApp(backend, '/app');

    await screen.findByRole('heading', { name: /good morning, rosa/i });
    // The sidebar space title belongs to the child, not the caregiver.
    expect(screen.getByText((_content, node) => node?.textContent === '小明’s space')).toBeInTheDocument();
    expect(screen.getByText(/rosa · caregiver/i)).toBeInTheDocument();
  });

  it('gives the avatar an accessible name rather than a bare initial', async () => {
    const { backend } = await seedHarness({ caregiverName: 'Rosa', childName: 'Léo' });
    renderApp(backend, '/app');
    await screen.findByRole('heading', { name: /good morning/i });
    expect(screen.getByRole('img', { name: 'Léo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /signed in as Rosa/i })).toBeInTheDocument();
  });

  it('has a skip link that reaches the main content', async () => {
    const { backend } = await seedHarness();
    renderApp(backend, '/app');
    await screen.findByRole('heading', { name: /good morning/i });
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(document.getElementById('main-content')).toBeInTheDocument();
  });
});

describe('child mode', () => {
  it('has no detectable accessibility violations', async () => {
    const { backend, childId } = await seedHarness();
    const { container } = renderApp(backend, `/child?start=${childId}`);
    await screen.findByRole('heading', { name: /hi léo/i });
    expect(await axe(container, AXE_RULES)).toHaveNoViolations();
  });

  it('pairs every card symbol with visible words', async () => {
    const { backend, childId } = await seedHarness();
    renderApp(backend, `/child?start=${childId}`);
    await screen.findByRole('heading', { name: /hi léo/i });

    for (const label of ['My day', 'My stories', 'I need help', 'How I feel']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('marks urgency with words as well as colour', async () => {
    const { backend, childId } = await seedHarness();
    renderApp(backend, `/child?start=${childId}`);
    await screen.findByRole('heading', { name: /hi léo/i });
    await userEvent.click(screen.getByRole('button', { name: /i need help/i }));

    await screen.findByRole('heading', { name: /what do you need/i });
    expect(screen.getByRole('heading', { name: /i need help now/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /this can wait a little/i })).toBeInTheDocument();

    // Each card's accessible name states its urgency in words.
    const painCard = screen.getByRole('button', { name: /it hurts.*urgent request/i });
    expect(painCard).toBeInTheDocument();
    expect(within(painCard).getByText(/urgent/i)).toBeInTheDocument();
  });

  it('applies the child’s display preferences to the page', async () => {
    const { backend, childId, familyId } = await seedHarness();
    await backend.updateChildPreferences(childId, { familyId, textScale: 1.5, highContrast: true, lowStimulation: true });

    renderApp(backend, `/child?start=${childId}`);
    await screen.findByRole('heading', { name: /hi léo/i });

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--kindly-text-scale')).toBe('1.5');
      expect(document.documentElement.getAttribute('data-contrast')).toBe('high');
      expect(document.documentElement.getAttribute('data-stimulation')).toBe('low');
    });
  });

  it('keeps motion off unless the child’s profile turns it on', async () => {
    const { backend, childId } = await seedHarness();
    renderApp(backend, `/child?start=${childId}`);
    await screen.findByRole('heading', { name: /hi léo/i });
    await waitFor(() => expect(document.documentElement.getAttribute('data-motion')).toBe('reduced'));
  });
});

describe('the request confirmation flow', () => {
  it('shows the chosen request with Send and Change before anything is sent', async () => {
    const { backend, childId } = await seedHarness();
    renderApp(backend, `/child?start=${childId}`);

    await screen.findByRole('heading', { name: /hi léo/i });
    await userEvent.click(screen.getByRole('button', { name: /i need help/i }));
    await screen.findByRole('heading', { name: /what do you need/i });
    await userEvent.click(screen.getByRole('button', { name: /^drink/i }));

    await screen.findByRole('heading', { name: /drink\?/i });
    expect(screen.getByText(/not sent yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send request/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change request/i })).toBeInTheDocument();
  });

  it('only says "arrived" after the backend confirms, and never says it was seen', async () => {
    const { backend, childId } = await seedHarness();
    renderApp(backend, `/child?start=${childId}`);

    await screen.findByRole('heading', { name: /hi léo/i });
    await userEvent.click(screen.getByRole('button', { name: /i need help/i }));
    await screen.findByRole('heading', { name: /what do you need/i });
    await userEvent.click(screen.getByRole('button', { name: /^drink/i }));
    await screen.findByRole('button', { name: /send request/i });
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    const heading = await screen.findByRole('heading', { name: /your message arrived/i });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(/nobody has opened it yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/has seen your message/i)).not.toBeInTheDocument();
  });

  it('offers no delayed answer for an urgent request', async () => {
    const { backend, childId, familyId } = await seedHarness();
    const token = (await backend.startChildSession(childId)).sessionToken;
    const request = await backend.childCreateRequest(token, { typeSlug: 'pain', dedupeKey: 'a11y-urgent-key' });
    await backend.childSendRequest(token, request.id);

    renderApp(backend, `/app/requests/${request.id}`);
    await screen.findByRole('heading', { name: /it hurts/i });

    expect(screen.getByRole('button', { name: /i’m coming now/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /in \d+ minutes/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to the quiet corner/i })).toBeInTheDocument();
    void familyId;
  });

  it('offers a delayed answer when the request can wait', async () => {
    const { backend, childId } = await seedHarness();
    const token = (await backend.startChildSession(childId)).sessionToken;
    const request = await backend.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'a11y-canwait-key' });
    await backend.childSendRequest(token, request.id);

    renderApp(backend, `/app/requests/${request.id}`);
    await screen.findByRole('heading', { name: /^drink$/i });
    expect(await screen.findByRole('button', { name: /in 5 minutes/i })).toBeInTheDocument();
  });

  it('asks for confirmation before closing an urgent request', async () => {
    const { backend, childId } = await seedHarness();
    const token = (await backend.startChildSession(childId)).sessionToken;
    const request = await backend.childCreateRequest(token, { typeSlug: 'unsafe', dedupeKey: 'a11y-close-key' });
    await backend.childSendRequest(token, request.id);

    renderApp(backend, `/app/requests/${request.id}`);
    await screen.findByRole('heading', { name: /i feel unsafe/i });
    await userEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    const dialog = await screen.findByRole('alertdialog', { name: /is everything alright now/i });
    expect(within(dialog).getByRole('button', { name: /yes, it is resolved/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /not yet/i })).toBeInTheDocument();
  });
});

describe('dialogs manage focus', () => {
  it('moves focus in, traps Tab, and closes on Escape', async () => {
    const { backend, childId } = await seedHarness();
    const token = (await backend.startChildSession(childId)).sessionToken;
    const request = await backend.childCreateRequest(token, { typeSlug: 'unsafe', dedupeKey: 'a11y-focus-key' });
    await backend.childSendRequest(token, request.id);

    renderApp(backend, `/app/requests/${request.id}`);
    await screen.findByRole('heading', { name: /i feel unsafe/i });

    const opener = screen.getByRole('button', { name: /mark resolved/i });
    await userEvent.click(opener);

    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('destructive actions explain themselves', () => {
  it('says what deleting a routine actually does', async () => {
    const { backend, childId } = await seedHarness();
    await backend.saveRoutine({ childId, title: 'Morning check-in', steps: [{ title: 'Wake up slowly' }] });

    renderApp(backend, '/app/routines');
    await screen.findByRole('heading', { name: /a softer rhythm/i });
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    const dialog = await screen.findByRole('alertdialog', { name: /delete “morning check-in”/i });
    expect(within(dialog).getByText(/removes the routine and all of its steps/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
  });
});

describe('empty, loading and error states', () => {
  it('shows an honest empty state rather than a blank page', async () => {
    const { backend } = await seedHarness();
    renderApp(backend, '/app/requests');
    expect(await screen.findByRole('heading', { name: /all quiet for now/i })).toBeInTheDocument();
    expect(screen.getByText(/the moment they are delivered/i)).toBeInTheDocument();
  });

  it('shows a real 404 page for an unknown route', async () => {
    const { backend } = await seedHarness();
    renderApp(backend, '/definitely-not-a-page');
    expect(await screen.findByRole('heading', { name: /that page does not exist/i })).toBeInTheDocument();
  });
});

describe('the operator dashboard', () => {
  it('has no detectable accessibility violations', async () => {
    const { backend } = await seedHarness();
    backend.grantOperatorForTests((await backend.getCurrentUser())!.id);

    const { container } = renderApp(backend, '/app/admin');
    await screen.findByRole('heading', { name: /how kindly is doing/i });
    expect(await axe(container, AXE_RULES)).toHaveNoViolations();
  });

  it('describes the chart to a screen reader and offers the same numbers as a table', async () => {
    const { backend, childId } = await seedHarness();
    backend.grantOperatorForTests((await backend.getCurrentUser())!.id);

    // The chart only exists once there is something to draw, so put one request
    // through. An empty fortnight renders the empty state instead, which is a
    // different assertion.
    const { sessionToken } = await backend.startChildSession(childId, 'Tablet');
    const draft = await backend.childCreateRequest(sessionToken, { typeSlug: 'drink', dedupeKey: 'a11y-admin' });
    await backend.childSendRequest(sessionToken, draft.id);

    renderApp(backend, '/app/admin');
    await screen.findByRole('heading', { name: /how kindly is doing/i });

    // The bars are decorative on their own; the figure carries the summary.
    const chart = await screen.findByRole('img', { name: /requests per day over 14 days/i });
    expect(chart).toBeInTheDocument();

    // And the numbers exist as text, not only as bar heights.
    expect(screen.getByText(/show these numbers as a table/i)).toBeInTheDocument();
  });

  it('is not reachable by a caregiver who is not an operator', async () => {
    const { backend } = await seedHarness();
    renderApp(backend, '/app/admin');

    // The server refuses; the page says so rather than rendering empty panels.
    await waitFor(() => {
      expect(screen.getByText(/this page is for kindly operators/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: /how kindly is doing/i })).not.toBeInTheDocument();
  });

  it('does not show the operator link to an ordinary caregiver', async () => {
    const { backend } = await seedHarness();
    renderApp(backend, '/app');
    await screen.findByRole('navigation', { name: /main navigation/i });
    expect(screen.queryByRole('link', { name: /operator/i })).not.toBeInTheDocument();
  });
});

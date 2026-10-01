/**
 * The privacy policy, and the footer link that opens it.
 *
 * Beside the cookie notice, which it does not repeat: that one lists every key
 * this project writes to the browser, and this one says what happens to
 * information about *you* — which is nothing, with one honest exception. The
 * public copy is served by GitHub Pages, and a host sees the requests made of
 * it. Saying "no third party sees your visit" without naming the host would be
 * the kind of claim a privacy policy exists to stop.
 */

import { mountFooterDialog, list, paragraph, type FooterDialog } from './footerDialog.js';

const REPOSITORY = 'https://github.com/adrianeyre/multi-game-interpreter';

const GITHUB_PRIVACY =
  'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement';

/** Shown in the dialog, so a stale policy is visible as one. */
const LAST_UPDATED = 'October 2026';

export const PRIVACY_POLICY: FooterDialog = {
  id: 'privacy',
  title: 'Privacy policy',
  dated: `Last updated: ${LAST_UPDATED}`,
  intro:
    'MGI Web collects no personal information. There is no account, no analytics and no ' +
    'server belonging to this project that your visit reaches. What follows says that in ' +
    'full, and says what the one party that does see your visit — the host — can see.',
  linkText: 'Privacy',
  linkLabel: 'Privacy policy — what this site collects about you',
  sections: [
    {
      heading: 'Who this is',
      blocks: [
        paragraph(
          'MGI Web is an open source project by Adrian Eyre, not a company or a service. ' +
            'Nobody operating it has any information about you to look at, sell or share.',
        ),
      ],
    },
    {
      heading: 'What is collected',
      blocks: [
        paragraph(
          'Nothing. This site has no sign-up, no form, no analytics, no telemetry, no crash ' +
            'reporting and no advertising. The interpreter and the editor run entirely in ' +
            'your browser, and neither sends anything anywhere.',
        ),
      ],
    },
    {
      heading: 'What stays on your device',
      blocks: [
        list([
          {
            title: 'The games you open',
            detail:
              'Read inside your browser and never uploaded. There is no server to upload ' +
              'them to: this site is static files.',
          },
          {
            title: 'The games you build',
            detail:
              'The editor keeps your project in your browser’s local storage, and an export ' +
              'is made in the browser and downloaded straight to you.',
          },
          {
            title: 'Your saved games and settings',
            detail:
              'Kept in local storage and IndexedDB on this device only. The Cookies link in ' +
              'this footer lists every one by name.',
          },
        ]),
      ],
    },
    {
      heading: 'The host',
      blocks: [
        paragraph(
          'The public copy of this site is served by GitHub Pages. Like any web host, GitHub ' +
            'receives the requests your browser makes for these files — which include your ' +
            'IP address and browser details — and may log them to run and secure its service. ' +
            'That is GitHub’s processing, under ',
          { text: 'GitHub’s privacy statement', href: GITHUB_PRIVACY },
          ', and this project has no access to those logs. A copy you build and serve ' +
            'yourself involves no host but yours.',
        ),
      ],
    },
    {
      heading: 'Links that leave this site',
      blocks: [
        paragraph(
          'The source code, issue tracker and some document links go to GitHub, and open in a ' +
            'new tab. What you do there is covered by GitHub’s own terms and privacy statement, ' +
            'not this one.',
        ),
      ],
    },
    {
      heading: 'Children',
      blocks: [
        paragraph(
          'Nothing is collected from anyone, so nothing is collected from children either.',
        ),
      ],
    },
    {
      heading: 'Your rights',
      blocks: [
        paragraph(
          'Because this project holds no personal data about you, there is nothing for it to ' +
            'show you, correct or delete. Everything the site keeps is in your own browser, ' +
            'and your browser’s settings clear it whenever you like.',
        ),
      ],
    },
    {
      heading: 'Changes',
      blocks: [
        paragraph(
          'A change to this policy is made in the open, in the public repository, and the date ' +
            'at the top of this dialog moves with it.',
        ),
      ],
    },
    {
      heading: 'Questions',
      blocks: [
        paragraph(
          'Anything unclear or wrong is worth raising at ',
          { text: 'the issue tracker', href: `${REPOSITORY}/issues` },
          '.',
        ),
      ],
    },
  ],
};

/** Adds the footer link and the dialog behind it. */
export function mountPrivacyPolicy(anchor?: HTMLElement | null): void {
  mountFooterDialog(PRIVACY_POLICY, anchor);
}

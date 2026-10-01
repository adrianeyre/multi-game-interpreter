/**
 * The terms and conditions, and the footer link that opens it.
 *
 * Short, because there is little to say: the software is free, the code is
 * GPL-licensed, and it runs on the reader's own machine. What does need saying
 * is the part an interpreter for other people's games has to be clear about —
 * the game data is the reader's to supply, and the trademarks are not ours.
 */

import { mountFooterDialog, list, paragraph, type FooterDialog } from './footerDialog.js';

const REPOSITORY = 'https://github.com/adrianeyre/multi-game-interpreter';

const GPL = 'https://www.gnu.org/licenses/gpl-3.0.html';

/** Shown in the dialog, so stale terms are visible as such. */
const LAST_UPDATED = 'October 2026';

export const TERMS: FooterDialog = {
  id: 'terms',
  title: 'Terms and conditions',
  dated: `Last updated: ${LAST_UPDATED}`,
  intro:
    'By using MGI Web you agree to these terms. They cover using this website; the code ' +
    'itself is covered by its open source licence, described below.',
  linkText: 'Terms',
  linkLabel: 'Terms and conditions — the rules for using this site',
  sections: [
    {
      heading: 'The software and its licence',
      blocks: [
        paragraph(
          'MGI Web is free software, released under the ',
          { text: 'GNU General Public License, version 3 or later', href: GPL },
          '. You may use, study, share and change it under that licence, and where these ' +
            'terms and the licence differ about the code, the licence wins.',
        ),
      ],
    },
    {
      heading: 'Game files are yours to supply',
      blocks: [
        paragraph(
          'This site ships no commercial game data. The games it runs come from files you ' +
            'open yourself, and you are responsible for having the right to use them — ' +
            'typically, by owning a copy. Do not use it to run copies you are not entitled to.',
        ),
      ],
    },
    {
      heading: 'What you make',
      blocks: [
        list([
          {
            title: 'Your own work is yours',
            detail:
              'A game you build in the editor belongs to you. This project claims no rights ' +
              'in it.',
          },
          {
            title: 'Someone else’s work stays theirs',
            detail:
              'Art, sound, text or scripts taken from an original game remain the property of ' +
              'whoever owns that game. Editing or exporting them changes nothing about who ' +
              'owns them, and sharing them may need that owner’s permission.',
          },
        ]),
      ],
    },
    {
      heading: 'Trademarks and affiliation',
      blocks: [
        paragraph(
          'LucasArts, Sierra, Adventure Soft, Revolution Software, SCUMM and every game named ' +
            'in this application are trademarks or property of their respective owners. MGI ' +
            'Web is an independent project and is not affiliated with, endorsed by or ' +
            'sponsored by any of them.',
        ),
      ],
    },
    {
      heading: 'Fair use of the site',
      blocks: [
        paragraph(
          'Do not use this site to attack, overload or interfere with it or its host, and do ' +
            'not present it, or anything made with it, as an official product of any of the ' +
            'owners named above.',
        ),
      ],
    },
    {
      heading: 'No warranty',
      blocks: [
        paragraph(
          'The software is provided “as is”, without warranty of any kind, as the licence ' +
            'itself sets out. Saved games and editor projects live in your browser’s storage, ' +
            'which your browser can clear; export anything you would not want to lose.',
        ),
      ],
    },
    {
      heading: 'Liability',
      blocks: [
        paragraph(
          'To the extent the law allows, the author is not liable for any loss that comes ' +
            'from using this site — lost saves and lost projects included. Nothing here limits ' +
            'a liability that the law does not allow to be limited.',
        ),
      ],
    },
    {
      heading: 'Privacy',
      blocks: [
        paragraph(
          'The Privacy link in this footer says what this site collects about you, which is ' +
            'nothing, and the Cookies link lists what it keeps in your browser.',
        ),
      ],
    },
    {
      heading: 'Changes',
      blocks: [
        paragraph(
          'These terms can change. A change is made in the open, in the public repository, ' +
            'and the date at the top of this dialog moves with it.',
        ),
      ],
    },
    {
      heading: 'Questions',
      blocks: [
        paragraph(
          'Anything unclear is worth raising at ',
          { text: 'the issue tracker', href: `${REPOSITORY}/issues` },
          '.',
        ),
      ],
    },
  ],
};

/** Adds the footer link and the dialog behind it. */
export function mountTerms(anchor?: HTMLElement | null): void {
  mountFooterDialog(TERMS, anchor);
}

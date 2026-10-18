# Visual design

The look of the web and desktop UI: a calm, first-party macOS style. Light is the default and follows the system theme. The waveform is the signature element. The accent is the logo blue. `ui-app.md` and `ui-library.md` say what each screen contains and which test ids it carries; this file says how it looks.

## Rules

- Colors only through the tokens below (as CSS variables). No color literals in components.
- One primary (filled blue) button per region. Secondary actions use the filled grey look, not outlines. Icon-only buttons are quiet and always have an accessible name.
- Touch targets are at least 40 px tall below 640 px wide. No horizontal page scroll at 320 px.
- Focus rings stay visible. Decorative SVGs and waveforms are hidden from assistive technology. Anything that moves is behind `prefers-reduced-motion: no-preference`.
- Copy is English, sentence case, short, no emoji.

## Color tokens

Values are OKLCH unless noted.

| Token | Light | Dark | Use |
|---|---|---|---|
| background | #FFFFFF | #1C1C1E | window content |
| foreground | 0.2316 0.0038 286.1 | 0.9626 0.0066 286.27 | text |
| card | #FFFFFF | #2C2C2E | raised surfaces (with the card shadow) |
| sidebar | #F5F5F7 | #252527 | sidebar background |
| sidebar-accent | #E3E3E8 | #3A3A3D | selected sidebar item |
| muted | #F5F5F7 | #2C2C2E | grouped lists, insets |
| muted-foreground | 0.5014 0.0078 286.11 | 0.7105 0.0072 286.22 | secondary text |
| secondary | #EFEFF2 | #323234 | filled grey buttons, search fields, segmented track |
| accent | #EBEBEE | #353538 | row hover |
| border | #E5E5EA | #38383A | hairlines |
| primary (logo blue) | 0.5494 0.2397 265.08 | same | primary button, selected row, play button, active icon, toggles |
| primary-foreground | white | white | text on primary |
| ring | same as primary | 0.6464 0.188 267.15 | focus ring |
| link | 0.4882 0.2172 264.38 | 0.7301 0.1389 266.26 | link text (never use primary for text) |
| destructive | 0.55 0.245 27.325 | 0.704 0.191 22.216 | destructive actions |
| success / on-success | 0.45 0.12 150 / 0.99 0 0 | 0.72 0.16 150 / 0.15 0.02 150 | status pill |
| warning / on-warning | 0.85 0.16 85 / 0.2 0.02 60 | 0.85 0.15 85 / 0.2 0.02 60 | status pill |
| info / on-info | 0.5 0.16 250 / 0.99 0 0 | 0.7 0.15 250 / 0.15 0.02 250 | status pill |
| waveform-played, waveform-cursor | logo blue | logo blue | played part of a waveform |
| waveform-unplayed | foreground at low opacity | same | unplayed part |
| transcript-active | logo blue at 9% | logo blue at a slightly higher mix | the segment being played |
| tile-blue / green / orange / gray / purple / indigo / pink / teal | 0.5494 0.2397 265.08 / 0.5685 0.1522 147.98 / 0.5534 0.1739 38.4 / 0.5399 0.0077 286.14 / 0.5261 0.1705 314.65 / 0.5106 0.2301 276.97 / 0.5313 0.2015 5.62 / 0.5198 0.0936 223.13 | same | settings icon tiles (white glyph) |

Card shadow: light `0 0 0 1px` black at 6% plus `0 1px 3px` black at 6%; dark a 1 px white ring at 7%.

## Type, shape, motion

- Font: the system font (SF Pro on macOS). Times, counts and durations use tabular numbers. Monospace only for keyboard hints.
- Sizes: page title 28 px bold, tight tracking (one per page, the h1). Section title 17 px semibold. Body 13–14 px. Secondary 12 px in muted-foreground. A label above a grouped list is 13 px semibold in foreground.
- Radius base 8 px. Cards and tiles 16 px; grouped lists 12 px; buttons, fields, rows 8 px; sidebar rows 6 px.
- A card is a card-colored surface with the card shadow and no border. Cards never nest. Pages are mostly flat with a few cards.
- Motion: 150–200 ms ease-out, for hover and press only.

## Regions

- Window: a 256 px sidebar (sidebar color, hairline right border) beside the content. A 52 px toolbar with a bottom hairline, a translucent background with blur, and a 15 px semibold title.
- Sidebar items: 40 px tall (32 px from 768 px wide), 13 px text, 16 px icon. The active item has the sidebar-accent background, semibold text, and a primary-colored icon. Counts are right-aligned, small and muted. Group labels are 11 px semibold muted.
- Dashboard tiles: card surfaces with 16 px padding; label 13 px muted; value 28 px semibold tabular; a 12 px hint. A tile that navigates is a link.
- Grouped lists (settings, recent): a muted container (card surface with shadow when inside a card context), rows at least 44 px tall with 16 px side padding, hairline dividers, label left and control right.
- Library rows: flat, 8 px radius; hover uses the accent color; the selected row is primary with primary-foreground text (secondary text and waveform bars at 80% of it).
- Segmented control: a secondary-colored track with 2 px padding; the active item is a background-colored pill with a small shadow and medium weight.
- Status pill: fully rounded, 11 px medium text, using the success, info or warning pair.
- Player card: card surface, 20 px padding; a muted 12 px meta line; a full-width waveform; centered transport with skip back, a 44 px round primary play button, skip forward; time on the left, speed on the right.
- Transcript rows: a timecode column (12 px tabular muted, a button that seeks), the speaker in semibold, text 15 px with a 28 px line height. The active segment uses the transcript-active background with an 8 px radius.
- Settings navigation: a "Search settings" field at the top; items 32 px tall with a 22 px rounded colored tile holding a white 14 px icon; the active item is primary with primary-foreground text; groups are separated by space, not labels. A section page starts with a 40 px tile, a 22 px bold title and a one-line description.

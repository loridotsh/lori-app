---
name: Lori Enterprise
description: Calm enterprise controls and a restrained Lori cowork workspace.
colors:
  background: "oklch(0.985 0.003 264)"
  foreground: "oklch(0.18 0.014 264)"
  card: "oklch(1 0 0)"
  primary: "oklch(0.55 0.2 36)"
  primary-foreground: "oklch(0.99 0.003 36)"
  primary-hover: "oklch(0.5 0.2 36)"
  primary-active: "oklch(0.46 0.19 36)"
  secondary: "oklch(0.965 0.005 264)"
  secondary-foreground: "oklch(0.24 0.012 264)"
  muted-foreground: "oklch(0.46 0.014 264)"
  border: "oklch(0.9 0.008 264)"
  border-strong: "oklch(0.82 0.01 264)"
  sidebar: "oklch(0.975 0.004 264)"
  sidebar-accent: "oklch(0.94 0.008 264)"
  destructive: "oklch(0.56 0.22 28)"
  success-muted: "oklch(0.96 0.03 160)"
  success-muted-foreground: "oklch(0.36 0.12 160)"
  warning-muted: "oklch(0.96 0.05 75)"
  warning-muted-foreground: "oklch(0.4 0.15 75)"
  background-dark: "oklch(0.15 0.012 264)"
  foreground-dark: "oklch(0.96 0.004 264)"
  card-dark: "oklch(0.18 0.012 264)"
  primary-dark: "oklch(0.7 0.19 36)"
  primary-foreground-dark: "oklch(0.14 0.02 36)"
  primary-hover-dark: "oklch(0.74 0.19 36)"
  primary-active-dark: "oklch(0.66 0.18 36)"
  secondary-dark: "oklch(0.22 0.012 264)"
  muted-foreground-dark: "oklch(0.66 0.014 264)"
  border-dark: "oklch(1 0 0 / 10%)"
  border-strong-dark: "oklch(1 0 0 / 18%)"
  sidebar-dark: "oklch(0.13 0.012 264)"
  sidebar-accent-dark: "oklch(0.21 0.012 264)"
  destructive-dark: "oklch(0.66 0.21 25)"
  success-muted-dark: "oklch(0.26 0.05 160)"
  success-muted-foreground-dark: "oklch(0.86 0.13 160)"
  warning-muted-dark: "oklch(0.26 0.06 75)"
  warning-muted-foreground-dark: "oklch(0.88 0.14 75)"
typography:
  title:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.025em"
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "28px"
  navigation:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  metadata:
    fontSize: "11px"
    fontWeight: 400
  code:
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "24px"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  composer: "16px"
  pill: "9999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 16px"
  button-outline:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 16px"
  button-ghost:
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 16px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 12px"
  navigation-current:
    backgroundColor: "{colors.sidebar-accent}"
    rounded: "{rounded.md}"
    typography: "{typography.navigation}"
    padding: "0 12px"
  attachment-chip:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    typography: "{typography.label}"
    padding: "4px 8px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  composer:
    backgroundColor: "#fdfdfc"
    textColor: "#21201c"
    rounded: "{rounded.composer}"
    padding: "8px"
    width: "720px"
  composer-dark:
    backgroundColor: "#292928"
    textColor: "#eeeeec"
    rounded: "{rounded.composer}"
    padding: "8px"
    width: "720px"
  mode-switch:
    rounded: "{rounded.md}"
    typography: "{typography.label}"
    padding: "2px"
---

# Design System: Lori Enterprise

## Overview

**Creative North Star: "Lori cowork workspace"**

The interface follows the established Lori desktop cowork direction: calm,
precise, and focused on completing and reviewing tasks. Cool neutral surfaces,
quiet typography, and a restrained orange accent let conversation, files, and
explicit decisions carry the hierarchy. The composer uses the established
Lori warm-neutral writing surface and foreground-colored Send control. This
name records the requested product direction; it does not introduce a separate visual identity.

This extraction documents Enterprise Cloud Work and its shared primitives.
Manage retains its incumbent administration layouts. Shared colors, typography,
focus treatment, and controls come from `apps/web/src/app/globals.css` and
`apps/web/src/components/ui`; Work composition comes from
`apps/web/src/components/work/cloud`. Preserve that scope when adding screens.

**Key Characteristics:**
- Flat surfaces with tonal separation and hairline boundaries.
- Compact navigation around a generous, readable conversation canvas.
- A single restrained action accent, with explicit text for state.
- The same visual hierarchy in light and dark themes.

## Colors

The palette pairs cool, faintly tinted neutrals with a warm orange action accent.
Frontmatter values preserve the source OKLCH notation. Unsuffixed entries are
light-theme values; `-dark` entries record the corresponding theme overrides.
Runtime components use the shared CSS variables so theme changes remain live.
`globals.css` remains authoritative for the full palette and aliases such as
input, ring, popover, and sidebar foreground.

### Primary
- **Action Orange** (`primary`): shared approval/save actions, focus, checkboxes,
  and linked output. Hover and active values communicate interaction.
- **Action Ink** (`primary-foreground`): contrast text on the action fill; its
  dark-theme counterpart is deliberately dark rather than white.

### Neutral
- **Cool Canvas** (`background`): the conversation and destination background.
- **Clear Surface** (`card`): shared inputs, outline actions, and existing cards.
- **Reading Ink** (`foreground`): task content and primary labels.
- **Quiet Surface** (`secondary`): user-message bubbles, attachment chips,
  code blocks, and subdued hover fills; alpha variants soften large regions.
- **Supporting Ink** (`muted-foreground`): metadata and secondary descriptions.
- **Hairline / Strong Hairline** (`border`, `border-strong`): structural edges
  and interactive emphasis. Dark borders use translucent white.
- **Sidebar Canvas / Current Row** (`sidebar`, `sidebar-accent`): navigation
  separation and selected conversation or destination.

Destructive red, success green, and warning amber are semantic exceptions.
Their muted pairs support status badges; labels must explain their meaning.

The composer has a scoped warm-neutral palette, matching Lori desktop Work.
Its writing surface, inset files header, border, supporting text, and hover fill
come from local `--work-*` variables in `cloud-composer.tsx`. Send uses local
reading ink against the writing-surface color, with muted neutral disabled
states. These component colors do not replace the shared Enterprise palette
or the orange administration actions.

**The Quiet Accent Rule.** Use the orange accent for actions, focus, and meaningful
state; do not turn entire conversation or destination surfaces into accent fills.

## Typography

**Body and UI Font:** Inter 4 (variable weight and optical size), self-hosted
from `apps/web/src/app/fonts/` through `next/font/local` in `src/app/fonts.ts`.
Only the Latin subset is preloaded; Latin Extended downloads only when a page
uses those characters. Open 4/6/9 (`cv02`–`cv04`) keep figures distinct, and
headings pick up Inter's display cut automatically at larger sizes.
**Code Font:** JetBrains Mono, matching Lori desktop, with programming
ligatures disabled so code reads literally.

Both fonts are SIL OFL 1.1 (licenses beside the files) and fall back to the
system stacks. Tables, `<time>` and badges use tabular figures; add
`tabular-nums` to other changing counts, sizes and durations.

Typography is compact and familiar. There is no decorative display face or
marketing headline system on this surface. The frontmatter body role describes
conversation prose; settings descriptions use the same size with a shorter
line height (24px).

### Hierarchy
- **Title:** destination headings. The conversation empty-state question is
  centered, 28px semibold (600), with tight line height and -0.03em tracking;
  web short-height layouts reduce it to 20px.
- **Body:** assistant output and user messages, with a readable maximum (70ch).
- **Navigation:** conversation titles and destination rows; current rows use
  medium weight (500). Long titles truncate within their available width.
- **Label:** composer selectors, small actions, and field labels. Composer
  draft text is 13px/24px on desktop and 16px/24px below 640px on the web.
- **Metadata:** organization name, tool state, versions, and secondary facts.
- **Code:** file editing; markdown code blocks are horizontally scrollable.

## Layout

Cloud Work fills the dynamic viewport (100dvh). Its outer frame does not scroll;
the conversation, destination content, sidebar history, and file body each own
their scrolling. Header and action controls remain outside those scroll bodies.
The header is compact (56px high), separated by a softened bottom hairline.
Conversation rename/delete actions sit in an overflow menu. Files, theme, and
account controls remain compact; the Files text label hides below 640px.

At the medium breakpoint (768px), the sidebar appears as a persistent column
(252px), collapsible to an icon rail (52px). The rail retains New conversation
and destination controls while hiding search, history, and text labels. Below
that breakpoint, a native dialog exposes navigation from the header menu; its
width is bounded by the viewport (`min(18rem, 100vw - 1.5rem)`). The Manage / Work
switch sits in the expanded navigation, using a subdued segmented treatment.

Conversation content uses a centered readable maximum (70ch). The composer
region has its own centered maximum (784px including horizontal padding):
32px per side from 640px, yielding a 720px writing surface on wide panes, and
16px per side below 640px. It contracts with the available pane width. Messages
have substantial vertical separation (32px). User messages align right in a
soft tonal bubble capped at 88% of the content width. Assistant output stays
directly on the canvas. Destination pages use a wider centered measure (56rem),
with flat sections and dividers rather than a dashboard card grid.

File preview sits beside the conversation at the extra-large breakpoint
(1280px). Its 520px default width can be resized by pointer or keyboard, within
360–880px and the space available beside a 400px conversation. The preference
persists locally. Below that breakpoint, preview occupies the conversation
region as a modal surface with contained focus and restoration on close.
Generated file cards open documents directly; a compact filename selector
switches between conversation files without a separate explorer or upload view.
The header holds download and close controls. Text edits autosave after a short
pause with version/hash conflict protection and a visible save status; pending
edits flush before file switching or closing. Failed saves retain the draft for
download and explicit recovery. Chat and preview hide their scrollbars while
retaining touch, wheel, and keyboard scrolling.

The empty-state question and composer form one vertically centered group.
After messages exist, the composer anchors below the independently scrolling
conversation. The web textarea auto-grows from 48px to `min(200px, 28dvh)`,
then scrolls vertically; attachments have their own bounded scroll area and
the model/upload/Send row remains visible. At short web heights (420px or
less), outer vertical spacing and heading size reduce. The native Cloud
composer follows the same split silhouette and centering, using its incumbent
13px draft text, 32px circular action, and `min(200px, max(48px, 30dvh))`
textarea cap. Native proportions and colors come from Lori desktop
`src/work/conversations/ConversationPane.tsx` and its `composer.css`; native
Cloud composition is in `src/work/cloud/CloudWorkspace.tsx`. Preserve these
platform-specific bounds and scroll relationships.

Shared buttons and inputs use larger narrow-width heights (44px) and compact
desktop heights (36px) from the small breakpoint (640px). Small buttons become
32px on desktop. Work navigation and toolbar controls have their own compact
sizes; do not assume all existing controls are 44px.

Composer repair captures under `.impeccable/review/composer-repair` are
`web-new-light-final.png`, `web-new-dark-final.png`,
`web-follow-up-light-final.png`, `web-phone-light.png`, `web-phone-dark.png`,
and `web-follow-up-phone.png`; native captures are `native-dark-fixed.png`,
`native-light-fixed.png`, `native-follow-up-light.png`, and `native-narrow.png`.
The phone-width web views use a browser window and zoom to exercise a roughly
403 CSS-pixel viewport; they are not real-device captures. Native views use
mocked Tauri bridges in a browser and do not qualify a packaged desktop app.
None of these visual captures qualifies live providers. Older
`web-follow-up-dark.png`, `native-dark.png`, and pre-repair cowork captures
are superseded for composer guidance. The earlier Files/Settings captures
remain references for those unchanged destinations.

## Elevation & Depth

The Work canvas is flat. Sidebar tone, hairline dividers, selected-row fills,
and modest control boundaries supply structure. Shared primary buttons and the
selected mode segment retain a small shadow from the incumbent primitives;
cards themselves have no default shadow. Do not add floating panel shadows or
glass effects to the cowork canvas. The native navigation dialog uses the
shared foreground-tinted backdrop.

**The Flat Workspace Rule.** Separate persistent task regions with tone and
hairlines; reserve elevation for existing interactive primitives and overlays.

## Shapes

Corners are restrained: compact fields and navigation use the medium radius,
shared cards use the large radius, user bubbles use the extra-large radius,
and the composer has its own slightly softer radius. These are deliberate
component roles, not a reason to round every region. Shared status badges are
pills; conversation attachments remain compact rounded rectangles. Structural
columns and destination sections have square edges.

## Components

### Buttons and fields

Reuse shared `Button` and `Input` variants. Shared primary actions use the
orange fill; outline actions have a clear surface and hairline boundary; ghost actions rely
on text and a quiet hover fill. Destructive actions use the existing semantic
variant when emphasis is needed. Disabled shared buttons use reduced opacity
(55%) and do not accept interaction. Visible keyboard focus uses the shared
ring, with the global outline as the baseline.

Text fields use the shared input border, a stronger hover border, and explicit
invalid styling. Composer provider/model selectors stay compact and visually
integrated with the composer rather than becoming large form controls.

### Navigation and mode switch

Current history and destination rows use the sidebar selection tone and medium
weight. Unselected rows use supporting ink and brighten on hover. Names truncate
without forcing the frame wider. Icon-only controls retain accessible labels.
The Manage / Work switch uses a neutral inset active segment with `aria-current`.

### Cards, chips, and conversation

Shared administration cards remain available for appropriate grouped content;
Work Settings and Providers primarily use open sections, concise headings,
and dividers. Attachment chips show a filename and explicit removal control.
Assistant markdown uses readable prose, semantic headings, underlined links,
and contained tables/code overflow. Copy actions appear on hover or keyboard
focus, and remain visible where hover is unavailable.

### Composer and tool disclosure

The composer has two connected layers: an inset Conversation files header
and a bordered writing surface that overlaps its lower edge by 8px. Both use
16px corners; the writing surface has 8px internal padding. The files header
is conditional on web file availability. Compact attachments stay inside the
writing surface above the draft. The model picker sits at the lower left; the
upload control and circular Send or Stop action sit at the lower right. Web
upload and Send targets are 44px below 640px and 32px above it. Send uses an
up-arrow icon, Stop a square, and both retain explicit accessible names.
Focus within strengthens the web border; controls retain visible keyboard
focus. Preserve draft visibility and the nonshrinking action row under zoom
and short-height pressure.

Tool activity uses compact text disclosures with an icon, action label, written
status, and chevron. Expanded detail uses a left hairline and indentation.
Approval and unknown outcomes open their details; decisions remain explicit.
Motion communicates state: shared color transitions are brief (150ms), chevrons
rotate with disclosure, and reduced-motion preferences suppress transitions and
animations. Theme changes do not animate through intermediate colors.
Surfaces enter from where they were invoked and leave faster than they arrive.
The shared tokens live in `globals.css` (`animate-menu-in`/`-out`,
`dialog-in`, `backdrop-in`, `sheet-in`, `reveal`, `fade-in`, `page-in`):
menus and popovers scale from their trigger (160ms in, 110ms out), modal
dialogs rise and fade (200ms), mobile navigation drawers slide from the left
edge, expanded disclosure bodies reveal (180ms), transcript messages fade in
once on mount, and a top-level destination fades in through `app/template.tsx`
(opacity only, no layout box). Buttons ease their 1px press. Do not animate
streaming text, layout widths, or anything that repeats while content updates.

### Inline generative response controls

Assistant responses can include inline visual documents in chronological order
alongside text and tool activity. Each document opens with a heading and summary,
then uses bounded blocks for metrics, charts, tables, calculators, steps, or
simulations. A local copy control exports the original data and default inputs.

Charts provide series visibility, exact-value inspection, and an optional data
table. Tables provide row filtering, stable column sorting, eight-row pagination,
and horizontal overflow inside their region. Calculators provide bounded number
and slider inputs, validation feedback, reset, and explicit undefined results;
step blocks provide numbered navigation with previous/next controls. Simulations
provide bounded parameter and timeline sliders, explicit Play/Pause/Reset
controls, and a visible playback status; playback starts paused. Typography stays
bounded at narrow widths, including the text-base simulation readouts.

These are native, local-only read-only controls. A failed or unknown visual leaves
a readable summary or status message so the surrounding conversation remains
usable.

## Do's and Don'ts

### Do:
- Do reuse shared theme variables and UI primitives in both themes.
- Do implement Work styling with scoped Tailwind utilities.
- Do preserve the 70ch transcript, separate 784px composer region, centered empty state, anchored follow-up composer, and independent scroll regions.
- Do pair status colors with explicit text and keep keyboard focus visible.
- Do preserve flat destination sections and the desktop cowork hierarchy.

### Don't:
- Don't introduce component-specific CSS files for Work features.
- Don't add gradients, glassmorphism, decorative animation, or excessive rounding.
- Don't replace the cowork canvas with an administration dashboard card grid.
- Don't hide composer actions behind scrolling draft content at short viewport heights.
- Don't treat zoom stress screenshots as real-device or live-provider qualification.

### Cloud project conversation navigation

The member Work sidebar uses expandable project folders instead of a scope dropdown.
Keep creation and administration as compact, labeled icon actions beside Projects. The full folder title toggles its group; the separate plus action starts a project conversation. Administration links to the Manage Projects page, never a management modal.
Expanded folders show at most five conversation previews; keep an older selected
conversation inside that limit. More progressively loads older history, and Show
less returns to the preview. Selecting a conversation opens its verified project
scope directly. Normal conversations remain visible outside project groups, including while a project is selected. The global New conversation action starts normal Work; each project has its own new-conversation action.
Use existing sidebar accents, 13px rows, a subtle 1px indentation guide, visible
keyboard focus, and semantic expansion controls. Keep the project name visible
above the conversation title even when narrow layouts hide the sidebar. Preserve
unsaved-change guards and discard stale or unauthorized preview responses.

### Project administration in Manage

Use the existing AppShell Projects destination with a searchable project list and
a detail panel. General, Access, Permissions, Connections, and Lifecycle are
compact section buttons. Keep unsaved forms mounted while changing sections.
Admins receive organization inventory and governance without implicit content
access; delegated managers receive only their authorized projects and actions.
Instruction editing requires an explicit project capability. Audited content
access remains a separate reason-bearing action. Keep permission restrictions,
member blocks, effective-access previews, and creation delegation discoverable.

### Work project overview and detail routes

Projects is nested beneath Work in the Manage navigation. Show it only after
server capabilities or an explicit project grant establish access. The overview
at `/work/projects` is a responsive grid of linked parent-project cards with
name, description, lifecycle state, and the viewer's access level. Creation
delegation is a secondary compact admin disclosure. Cards navigate to
`/work/projects/[projectId]`; detail pages have an All projects return link and
retain the permission-specific forms without a simultaneous project list.
Members can browse explicitly shared projects, while editing remains governed by
action capabilities. Preserve the Work chat sidebar as the execution surface.

### Discoverable Work management and searchable selectors

Work is an expandable navigation group with just Manage Work (My Work access for
members) and authorized Projects. The existing Work page remains the single
management destination for its Access, Providers & models, and Plugins & skills
tabs. Usage and workspace launch stay in their existing page controls and mode
switch. Do not duplicate those destinations in the sidebar. The parent toggles
the group; highlight Manage Work across its sections and keep the navigation
scrollable on smaller screens.

Project membership, role, block, effective-access, and creation-delegation pickers
use the shared SearchSelect control rather than native OS menus. Match the Lori
popover palette, cap desktop width at 24rem, constrain height to available space,
and retain 44px touch rows. Search includes names, emails, and group labels. Show
member/team grouping, secondary descriptions, selected checks, and disabled
already-assigned entries. Preserve keyboard navigation, Escape focus restoration,
Tab continuation, and popup withdrawal when the owning form is locked. Selection
only stages changes; permission mutations remain behind explicit Save actions.

## Inline Work visuals

Render diagrams, charts, tables and other validated visuals inside assistant
responses, between the surrounding Markdown paragraphs. Reusable artifacts and
ordinary files use the existing workspace preview/editor and file delivery
actions. Do not add a separate artifact launcher, management form or output
selector.

Use semantic tokens, scoped Tailwind utilities, restrained separators and readable
text alternatives. Preserve chronological reading order and stable tool identities
through streaming. Use Mermaid’s standard default theme and original direction, without palette,
font, spacing, curve or layout overrides. Show a simple inline preview on a white
canvas. Clicking it opens the same image at actual size in the existing dialog,
with zoom, Fit, Copy Mermaid and native close/Escape behavior. Preserve focus
restoration and withdraw the dialog when its conversation becomes inactive. Local controls
must not affect approvals, the composer or persisted messages.

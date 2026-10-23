# Luxury Mailer UI

## Direction

Dark desktop interface with restrained silver accents and liquid-glass controls. Glass is reserved for interactive or floating elements; large content surfaces remain quieter for contrast.

## Typography

- Manrope Variable: navigation, headings and interface copy.
- Space Mono: metrics, dates, statuses and compact technical labels.
- Avoid body text below 11 px and interactive labels below 9 px.

## Color roles

- Near-black: application and panel surfaces.
- Silver: primary action, selection and data emphasis.
- Green: connected, active and successful states only.
- Red: destructive actions and errors only.

## Components

- `GlassButton`: secondary, icon and compact actions.
- `GlassButton variant="primary"`: the single primary action in a section.
- `Panel`: content surface for charts, tables and forms.
- `WindowChrome`: native desktop title bar and window controls.

## Rules

- Keep one obvious primary action per screen.
- Use glass on controls, menus, tooltips and modals—not every surface.
- Use 150–200 ms transitions and avoid bouncing motion.
- Prefer spacing and typography over decorative borders.
- Browser mode is for layout development; window controls activate only inside Tauri.

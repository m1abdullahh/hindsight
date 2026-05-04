# 09 — Privacy & Ethics

> A monitoring tool sits on a sharp ethical edge. Decisions here are *product* decisions, not afterthoughts. This doc records what we will and will not do, and why.

## Principles

1. **Visible always.** The tracked user always knows when they're being recorded. Tray icon, in-app banner, optional capture flash. Surreptitious tracking is not a feature we will ever ship.

2. **Content of input is never captured.** We log counts of keystrokes and mouse events, never the keys, characters, positions, or timing.

3. **The screen is the product surface, but it's not unbounded.** The user can pause tracking. The user can delete a screenshot within a grace window if they accidentally captured something personal. Both are first-class features, not workarounds.

4. **Admins see what they need, not everything they could.** Default project setting is "no blur"; flipping on `blurScreenshots` is a one-click privacy upgrade for sensitive work. We may eventually default it ON for new projects — TBD.

5. **The user's own data is theirs.** Members can see all of their own screenshots, time entries, and activity metrics. No "manager-only" view of personal data without the member also having access.

6. **Retention is finite.** 90-day default, configurable per org down to 14 days. We don't keep screenshots forever just in case.

7. **No dark patterns.** No fake pause buttons that don't pause. No "are you sure you want to stop tracking" hesitation prompts. No emails to admins when members pause.

## What we capture

| Data | Captured? | Notes |
|---|---|---|
| Screenshots of all monitors | Yes, while tracking is active | One image per monitor per window |
| Active window title | Yes | Stored on screenshot row |
| Active app name | Yes | |
| Keystroke counts (per window) | Yes | Numeric only |
| Mouse event counts (per window) | Yes | Numeric only |
| Idle duration | Yes | Whole-window granularity |
| URL of active browser tab | **No** | Out of scope; revisit only with explicit per-org opt-in |
| Keystroke contents | **Never** | |
| Clipboard contents | **Never** | |
| Audio | **Never** | |
| Webcam | **Never** | |
| Files on disk | **Never** | |
| Network traffic | **Never** | |
| GPS / location | **Never** | |

## When we don't capture

- Tracking is paused.
- App is quit.
- User is in the IDLE state past threshold *(captures pause until they return and resolve the prompt)*.
- The active window is on a screen flagged as private *(future feature; not v1)*.

## Member rights

- **See your data.** Same dashboards as admins, scoped to self.
- **Delete recent screenshots.** Default 5-minute grace window after capture; deletion is irreversible after that.
- **Stop tracking, immediately, always.** No "pause requires manager approval" mode. We won't build that.
- **Export your data.** A "download my data" button generates a ZIP of metadata and screenshot URLs. *(Required for GDPR-style requests; build by v1.1.)*
- **Know who looked at what.** Audit log entries for screenshot views are deferred to v1.1 but reserved in the schema.

## Admin responsibilities (enforced or surfaced)

- Project privacy setting (`blurScreenshots`) is a first-class field, surfaced when creating a project.
- Audit log shows every member-management and screenshot-deletion action.
- An "Org privacy settings" page consolidates: retention period, default blur, idle threshold, capture-flash policy. *(v1.0 may use defaults only; the page lands in v1.1.)*

## Legal posture

We are not lawyers. The tool has to be *deployable* by an org that is itself responsible for legal compliance in their jurisdiction. To that end, we make compliance easier:

- **Disclosure surface.** A "What this app records" screen on first install, copyable text in admin docs to use in employment notices.
- **Consent capture.** First-run accept flow with timestamp logged to the device record.
- **Configurability.** Retention, blur, idle behavior are knobs admins can turn to match local rules.

We do not claim, in product or marketing, that the tool is GDPR-, HIPAA-, SOC2-, or [regulation]-compliant. Those are deployment-context claims.

## Things we will say no to

- "Add a stealth mode that hides the tray icon." → No.
- "Capture the keys, not just counts, so we can detect leaks." → No.
- "Disable the user's ability to pause." → No.
- "Take an extra screenshot when activity drops." → No (defeats the randomization promise).
- "Auto-flag screenshots with low activity for review." → No, in v1. This is exactly the kind of ML-on-employees feature that erodes trust and we'd rather not build at all.

## Things we'd consider with explicit opt-in

- Browser URL capture (per-project flag, banner shown to user).
- OCR of screenshot text for searchability (per-project flag, results visible to the member too).
- Webcam capture (we'd probably still say no, but at least it's not a flat-out "never" line in product strategy).

## What this doc commits us to

If a feature would break one of the principles above, it does not ship without changing this doc first. Changing this doc is a deliberate act and requires explicit owner sign-off, recorded in the changelog at the bottom of this file.

## Changelog

- _Initial draft — pre-v1 planning._

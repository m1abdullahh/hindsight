## What's new

- If your session is revoked from the web app (or by an admin), the desktop notices within seconds — even when you're idle and not actively tracking — and signs you out cleanly with a clear message. Captures stay safe in the outbox until you sign back in, and your machine won't quietly retry uploads against a dead session.
- Uploaded screenshots are now cleared from your local outbox 24 hours after upload, and the row goes away after a week. Your machine no longer holds an ever-growing copy of every screenshot you've ever taken.
- When you go idle and the tracker auto-pauses, you'll now get a Windows notification — same as the one you see for screenshots — so you know captures have stopped until you're back. A second notification fires when you return and tracking resumes.
- The in-app "Keep / Discard idle" prompt has been removed in favour of the new notifications. Idle time is now always recorded on the entry, which is reflected in the activity % on your reports; billable time is unchanged (only active time has ever counted toward pay).
- Tracker now pauses the moment you lock your screen (Win+L on Windows, Ctrl+Cmd+Q on macOS, screensaver on Linux) and resumes when you unlock — no more waiting for the 5-minute idle timer. Locked time is left out of the session entirely (not counted as either active or idle), so reports show a clean gap.

## Fixes

- Tracking that runs past midnight is now split at the day boundary, so each day gets its own entry. Overnight sessions previously counted entirely toward the day they started, leaving "today" empty on both the desktop and the admin reports — those totals are now accurate. At midnight the timer resets to count the new day.
- After installing an update, the app now reopens to the foreground instead of launching behind your other windows — you no longer need to click the dock icon to bring it back.
- Switching between the **Track** and **Me** tabs no longer flashes a loading spinner or re-fetches data — your stats stay on screen the moment you click back, and refresh quietly in the background.
- The project picker stays current even after you've been on another tab for a while: if an admin unassigns you from a project in the web app, that project will quietly drop out of the picker before you try to start tracking it.
- Tracking sessions used to silently lose track of accumulated idle time when you switched tabs mid-session. That state is now preserved across tab switches.
- Deleting a screenshot you weren't allowed to remove (for example an older capture, from the **Me** tab) no longer signs you out. You now just get a "couldn't delete" message and stay logged in.
- The **Me** tab no longer shows a Delete button on your own older screenshots that can't actually be removed. Since you can only delete your own captures within 5 minutes of taking them, older ones now show a short note explaining that an admin has to remove them — instead of a button that fails.
- Fixed a crash on launch on newer Linux versions (Ubuntu 24.04 and later, including 26.04). The app now starts reliably on these systems.

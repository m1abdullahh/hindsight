## What's new

- If your session is revoked from the web app (or by an admin), the desktop notices within seconds — even when you're idle and not actively tracking — and signs you out cleanly with a clear message. Captures stay safe in the outbox until you sign back in, and your machine won't quietly retry uploads against a dead session.
- Uploaded screenshots are now cleared from your local outbox 24 hours after upload, and the row goes away after a week. Your machine no longer holds an ever-growing copy of every screenshot you've ever taken.
- When you go idle and the tracker auto-pauses, you'll now get a Windows notification — same as the one you see for screenshots — so you know captures have stopped until you're back. A second notification fires when you return and tracking resumes.
- The in-app "Keep / Discard idle" prompt has been removed in favour of the new notifications. Idle time is now always recorded on the entry, which is reflected in the activity % on your reports; billable time is unchanged (only active time has ever counted toward pay).

## Fixes

- After installing an update, the app now reopens to the foreground instead of launching behind your other windows — you no longer need to click the dock icon to bring it back.
- Switching between the **Track** and **Me** tabs no longer flashes a loading spinner or re-fetches data — your stats stay on screen the moment you click back, and refresh quietly in the background.
- The project picker stays current even after you've been on another tab for a while: if an admin unassigns you from a project in the web app, that project will quietly drop out of the picker before you try to start tracking it.
- Tracking sessions used to silently lose track of accumulated idle time when you switched tabs mid-session. That state is now preserved across tab switches.

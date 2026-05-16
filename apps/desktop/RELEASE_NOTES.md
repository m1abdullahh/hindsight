## Fixes

- Switching between the **Track** and **Me** tabs no longer flashes a loading spinner or re-fetches data — your stats stay on screen the moment you click back, and refresh quietly in the background.
- The project picker stays current even after you've been on another tab for a while: if an admin unassigns you from a project in the web app, that project will quietly drop out of the picker before you try to start tracking it.
- Tracking sessions used to silently lose track of accumulated idle time when you switched tabs mid-session. That state is now preserved across tab switches.

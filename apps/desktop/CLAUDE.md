# Desktop app — agent conventions

## Release notes: keep `apps/desktop/RELEASE_NOTES.md` current

Any change in `apps/desktop/` that a user will notice should land in `apps/desktop/RELEASE_NOTES.md` **in the same commit as the code change**. When the maintainer cuts the next desktop release, the file's contents are baked at build time into:

- the GitHub release page (rendered as Markdown), and
- the in-app auto-updater dialog (plain text; ~10 lines visible before scroll — see `src/components/UpdaterDialog.tsx`).

Both surfaces show the same text, so write for a non-technical user. Pipeline details live in [docs/12-desktop-updater.md](../../docs/12-desktop-updater.md).

### When to add an entry

Add an entry for: new features, bug fixes, UX changes, permission/onboarding changes, performance improvements that are noticeable, breaking changes (label these clearly).

Skip: refactors with no behavior change, CI / workflow / build changes, internal dependency bumps, doc edits, new tests, new lint rules.

If you're unsure, err toward adding it — a friendly line is cheap, silent regressions are not.

### Format

The file represents **the next unreleased version**. If there's already content in it, append to the relevant section rather than replacing it. Versions and dates are added automatically by the release workflow — don't write them in.

```markdown
## What's new

- One-line description, written for users (not "refactored `useFoo`" — "screenshots now take ~30% less time to upload").

## Fixes

- Past-tense, names the user-visible symptom, not the internal cause.

## Breaking

- Only if a user's saved state, login, or workflow is affected. Explain what they need to do.
```

Keep each bullet to one line where possible. The in-app dialog has limited space; verbose notes get truncated visually even though they scroll.

### Lifecycle

The file persists across releases. After publish, the maintainer either edits in place or `git rm`s it. As an agent, you should:

- **Append** if the file exists — assume the content is for the next release.
- **Create** if it doesn't exist (it's gitignored by absence, not by `.gitignore` — just `Write` it).
- **Never** delete it or remove other agents' / humans' entries.

If the existing entries look like they describe a release that already shipped (e.g. you see them on the GitHub releases page), flag this to the user rather than silently editing.

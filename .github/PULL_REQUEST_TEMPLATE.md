## Summary

<!-- What changed, and why. Link the related issue, for example "Closes #123". -->

## How I tested it

<!-- The commands you ran and the results. For UI changes, say which screens you checked. -->

The CI jobs (`server`, `msrv`, `web`, `extension`, `desktop`, `pipeline`, `contract`) run the
formatter, the lints, the tests and both contract suites on every pull request, so they do not
need a checklist here. Record what CI cannot see:

- **E2E on a real process.** Anything that needs a running server, a real provider, a network
  peer or a second process. Say what you ran and what you saw.
- **Reverse verification.** For a fix or a new guard, say how you proved the test catches the
  bug: revert the change, watch the test fail, restore it. Name the test.
- **Manual checks.** Screens you opened, dialogs you tried, hardware or a real recording.

## Checklist

- [ ] Commit messages follow Conventional Commits.
- [ ] Behavior changes update the matching file in `spec/` and the tests that pin it.
- [ ] Documentation in `docs/` is updated for user-visible changes.
- [ ] The entry under **Unreleased** in `CHANGELOG.md` is updated for user-visible changes.
- [ ] No secrets, personal data, recordings or generated files are included.

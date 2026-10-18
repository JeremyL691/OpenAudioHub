## Summary

<!-- What changed, and why. Link the related issue, for example "Closes #123". -->

## How I tested it

<!-- The commands you ran and the results. For UI changes, say which screens you checked. -->

- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy -p oah --all-targets -- -D warnings`
- [ ] `cargo test -p oah`
- [ ] `pnpm --dir web typecheck` and `pnpm --dir web build`
- [ ] `contract-tests/run.sh server`

## Checklist

- [ ] Commit messages follow Conventional Commits.
- [ ] Behavior changes update the matching file in `spec/` and the contract tests.
- [ ] Documentation in `docs/` is updated for user-visible changes.
- [ ] The entry under **Unreleased** in `CHANGELOG.md` is updated for user-visible changes.
- [ ] No secrets, personal data, recordings or generated files are included.

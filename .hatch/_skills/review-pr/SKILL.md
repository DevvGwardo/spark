---
description: Review an open GitHub pull request for correctness, design-system adherence, and test coverage.
---

# review-pr

When asked to review a PR, work in this order:

1. Check out the branch and read the diff end-to-end before commenting.
2. Report findings in three buckets: (1) correctness bugs, (2) design-context violations (see the Design Context rule — density, dark-first, motion under 200ms, WCAG AA), (3) missing or weak tests.
3. Quote `file:line` for every finding so it's clickable.
4. Lead with the highest-severity issue; don't bury a bug under style nits.

Run `scripts/checkout-pr.sh <pr-number>` to fetch the branch before reviewing.

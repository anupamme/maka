# Code Review Priorities

When reviewing pull requests:

- Review the change against the problem and root cause it claims to address.
- Prioritize concrete correctness, security, data-loss, concurrency, compatibility, and behavioral-regression risks.
- Check whether the change extends the existing source of truth or creates a parallel path.
- Flag code that can be deleted or simplified when doing so has a concrete correctness or maintenance benefit.
- Flag tests that duplicate stronger coverage, assert implementation details, or do not protect observable behavior.
- Avoid style-only comments, speculative refactors, praise, and restating the pull request summary.
- Lead with actionable findings. If none exist, say so and identify only material residual validation gaps.

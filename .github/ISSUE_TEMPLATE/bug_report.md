---
name: Bug report
about: Something broken? Tell us about it.
title: "[Bug] "
labels: bug
---

**Describe the bug**
A clear description of what's wrong.

**To Reproduce**
Steps to reproduce the behavior:
1.
2.
3.

**Expected behavior**
What did you expect to happen?

**Environment**
- CloudGate version: (run `docker exec cloudgate cat /app/.version`)
- Docker image tag: (e.g. `:latest`, `:v0.1.0`, `:nightly`)
- Host OS:
- Cloudflare account region/plan: (Free / Pro / Business)

**Container logs**
<details>
<summary>Click to expand</summary>

```
docker logs cloudgate --tail 200
```

</details>

**Additional context**
Anything else that might help — screenshots, network setup, recently changed config.

**For security issues**: see [`SECURITY.md`](../../SECURITY.md) — do NOT open a public issue.

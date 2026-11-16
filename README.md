# github-core-clone-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/indrairawan4503-cmd/github-core-clone-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/indrairawan4503-cmd/github-core-clone-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP (clone + push, protocol v2), repositories, issues, pull requests and contents over the REST v3 API, queries and mutations over GraphQL, and tools over MCP — all served from a deterministic in-memory store with no outside service.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

Without `MAKEFUN_ENV_URL` the forge serves standalone on `PORT` (default 18080) until SIGTERM, which is how the kit's local conformance runner talks to it.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8dxq9bq0&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

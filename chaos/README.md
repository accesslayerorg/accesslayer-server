# Chaos suite

## Components

- Postgres, Redis, mock Soroban RPC
- Toxiproxy proxies: postgres `15432`, redis `16379`, soroban `18081`
- Specs in `chaos/specs/*.json`

## Run

```bash
docker compose -f chaos/docker-compose.chaos.yml up -d --build
./chaos/run-chaos.sh
```

## Add a scenario

1. Add spec file in `chaos/specs/`.
2. Add a test case in `chaos/run-chaos.sh` or a dedicated script.
3. Ensure failure artifacts (toxiproxy config, logs) are uploaded in CI.

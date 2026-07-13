# Shared Agent Adapter Runtime

This module owns the strict Host Local API client shared by the CLI and the CI gate. It accepts only canonical literal loopback HTTP origins, reads the bearer token from controlled configuration, disables redirects, bounds request and response bodies, applies a request deadline, and strictly decodes Host JSON. Alternate IPv4 spellings such as integer, hexadecimal, octal, or abbreviated forms are rejected before URL normalization.

It exposes only implemented public Host operations. It does not import Data ports, SQLite, Object Store implementations, Workspace paths, Runtime transports, or product UI.

Environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `VISTREA_HOST_URL` | yes | Exact `http://127.0.0.1:<port>` or `http://[::1]:<port>` origin |
| `VISTREA_HOST_TOKEN` | yes | Per-start 256-bit Host bearer token |
| `VISTREA_HOST_TIMEOUT_MS` | no | Request deadline from 1 through 300000 milliseconds |
| `VISTREA_HOST_MAX_RESPONSE_BYTES` | no | JSON response ceiling, at most 128 MiB |

The URL must be exactly `http://127.0.0.1:<port>` or `http://[::1]:<port>` without credentials, query, fragment, path, or trailing slash. Responses must be identity encoded JSON; a declared `Content-Length` must exactly match the bytes read. The token is never accepted as a CLI argument. Client errors retain only sanitized Host diagnostics and never include request headers, environment values, or a fetch URL.

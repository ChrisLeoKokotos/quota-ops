# Local and Self-Hosted Runtimes

QuotaOps is a product created by **SO HOMELY**.

Provider quota and self-hosted compute capacity are different concepts. QuotaOps keeps them separate instead of inventing quota for runtimes that do not expose one.

## Ollama

Ollama is the first local runtime integration.

The collector checks only the fixed local address:

```text
http://127.0.0.1:11434
```

It reads the local Ollama version, installed model list, and currently loaded model list.

QuotaOps can display model name, family, parameter size, quantization, local model size, loaded VRAM, context length, and load state when those values are reported by Ollama.

## Verify locally

Run:

```powershell
npm run collector:setup -- runtimes
```

An offline result is valid when Ollama is not installed or not running.

## No synthetic quota

Open-weight models running locally do not inherently have a provider reset window or weekly allowance.

QuotaOps therefore does not create an artificial percentage, quota, or reset time for Ollama.

Runtime capacity is represented through verified runtime state such as model availability and memory use.

## Token usage

Ollama generation responses can contain per-request token metrics such as prompt and output token counts.

The Ollama runtime API does not provide a built-in historical account-wide token counter. QuotaOps does not claim historical Ollama token usage unless it has directly observed and persisted the relevant request metrics.

A future opt-in request-observation path can add cumulative Ollama Token Analytics without changing this rule.

## Security boundary

The initial Ollama integration performs read-only GET requests to fixed loopback endpoints. It does not accept a user-supplied runtime URL and therefore does not add a generic network destination or SSRF surface.

The runtime result is normalized before it reaches the dashboard.

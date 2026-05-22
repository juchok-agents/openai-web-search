# OpenAI Web Search

Use this skill when the user asks for current web information, recent facts, sources, or cited research.

This skill is a CLI-first interface. Call it from bash; do not expect an agent tool.

## Requirements

One of these authentication methods must be configured in the workstation:

- `OPENAI_API_KEY` for direct OpenAI API access.
- Codex / ChatGPT auth in `$PI_CODING_AGENT_DIR/auth.json`.

## Usage

Search the web:

```bash
bun "$MEMORY_DIR/main/skills/openai-web-search/search.ts" \
  --query "OpenAI web_search Responses API current limitations"
```

The default output format is JSON:

```json
{
  "text": "Answer text...",
  "sources": [
    {
      "title": "Source title",
      "url": "https://example.com"
    }
  ]
}
```

Use text output for quick reading:

```bash
bun "$MEMORY_DIR/main/skills/openai-web-search/search.ts" \
  --query "latest Node.js LTS version" \
  --format text
```

The default search model is `gpt-5.5`. Override it with `--model` or `OPENAI_WEB_SEARCH_MODEL`.

Use `--context-size low|medium|high` to control how much search context the model receives.

Use `--cached` when live web access is not needed.

The CLI should fail loudly when authentication is missing.

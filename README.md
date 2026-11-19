<p align="center">
  <a href="https://ellipsis.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://www.ellipsis.dev/brand/lockup-dark-transparent.png">
      <img alt="ellipsis.dev" src="https://www.ellipsis.dev/brand/lockup-light-transparent.png" width="360">
    </picture>
  </a>
</p>

<p align="center">
  Run Claude Code, Codex, and Gemini sessions in the cloud<br>
  with configurable environments, permissions, and budgets.
</p>

## Documentation

For installation [see below](#installation). For usage see the [docs](https://ellipsis.dev/docs).

## Agent skills

The [`ellipsis` skill](skills/ellipsis/SKILL.md) teaches a coding agent to use Ellipsis.

```sh
npx skills add ellipsis-dev/cli
```

## Installation

```sh
curl -fsSL https://ellipsis.dev/install.sh | sh
```

```sh
el auth login
el --model claude-opus-5-5 "Find and fix the failing test."
```

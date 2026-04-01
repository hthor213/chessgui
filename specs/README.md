# Specs

Feature specs live here. They define **what** we're building and **when it's done** — before implementation starts.

## Band Numbering

`{NNN}-{slug}.md` — band-based numbering, kebab-case slug.

| Band      | Purpose                                      |
|-----------|----------------------------------------------|
| 000       | Vision — singleton north-star document        |
| 001-019   | Foundation — building blocks everything needs |
| 010-099   | MVP — first usable capabilities               |
| 100-199   | V1 — Lichess polish                          |
| 200-299   | V2 — SCID power (database, opening tree)     |
| 900-999   | Backlog/ideas — uncommitted explorations      |

## Dependency Graph

```
016 (Game Tree) ──blocks──► 200 (Database)
                           201 (Opening Tree)
                           202 (Annotations)
                           203 (Eval Graph)
```

spec:016 is the foundational data model that all V2 features build on.

## Status Flow

`draft` -> `active` -> `done`
